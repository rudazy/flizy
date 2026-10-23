/**
 * The flizy.app side of a passkey approval for one chat payment over the daily
 * cap (lib/custody/approvals.js opens it and sends it).
 *
 * Everything shown comes from the stored row, found by the sha256 of the link
 * token and the signed-in account together: the URL carries only the token,
 * never a recipient or an amount, and another account's session finds nothing.
 * The passkey signs a one-off permission for exactly that payment (this
 * recipient, this amount, once, until the approval expires), the account
 * itself confirms the signature on chain, and only then is it marked signed
 * for the bot host's relayer to send. Every status change is compare-and-set.
 */

import { createHash, randomBytes } from 'crypto';
import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ClientError } from '../apiError.ts';
import { buildOneOff, delegationDigest, type AssetSymbol } from './delegations.ts';
import { b64url, encodeAssertion, fromB64url } from './webauthn.ts';
import { inPilot, NOT_IN_PILOT, type SignedAnswer } from './ceremony.ts';

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const ERC1271_OK = '0x1626ba7e';
const IS_VALID_SIGNATURE = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);

export const APPROVAL_NOT_FOUND = 'This approval link does not open a payment for this account.';

export type ApprovalView = {
  status: string;
  asset: AssetSymbol;
  amount: string;
  recipientLabel: string | null;
  recipientAddress: string;
  expiresAt: string;
  txHash: string | null;
};

type Row = {
  id: string;
  account_id: string;
  transfer_id: string | null;
  symbol: AssetSymbol;
  gator: string;
  delegate: string;
  to_address: string;
  recipient_label: string | null;
  amount: string;
  amount_display: string;
  status: string;
  digest: string | null;
  expires_at: string;
  tx_hash: string | null;
};

export type ApprovalDeps = {
  /** A read-only eth_call. */
  call: (to: string, data: string) => Promise<string>;
  now?: () => Date;
};

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The row behind a token, only for the account that owns it. */
async function findRow(supabase: SupabaseClient, accountId: string, token: string): Promise<Row> {
  if (!inPilot(accountId)) throw new ClientError(NOT_IN_PILOT);
  if (!TOKEN_RE.test(String(token || ''))) throw new ClientError(APPROVAL_NOT_FOUND);
  const { data, error } = await supabase
    .from('custody_approvals')
    .select('id, account_id, transfer_id, symbol, gator, delegate, to_address, recipient_label, amount, amount_display, status, digest, expires_at, tx_hash')
    .eq('token_hash', tokenHash(token))
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  // Another account's link and a link that never existed read the same.
  if (!data) throw new ClientError(APPROVAL_NOT_FOUND);
  return data as Row;
}

function isOpen(row: Row, now: Date): boolean {
  return row.status === 'pending' && new Date(row.expires_at).getTime() > now.getTime();
}

/** What the approval page shows, from the stored row alone. */
export async function viewApproval(supabase: SupabaseClient, accountId: string, token: string, deps: ApprovalDeps): Promise<ApprovalView> {
  const row = await findRow(supabase, accountId, token);
  const now = (deps.now ?? (() => new Date()))();
  const late = (row.status === 'pending' || row.status === 'signed') && new Date(row.expires_at).getTime() <= now.getTime();
  return {
    status: late ? 'expired' : row.status,
    asset: row.symbol,
    amount: row.amount_display,
    recipientLabel: row.recipient_label,
    recipientAddress: ethers.getAddress(row.to_address),
    expiresAt: row.expires_at,
    txHash: row.tx_hash ?? null,
  };
}

/**
 * Builds the one-off permission for exactly this payment and returns its
 * digest as the passkey challenge. Built fresh on each start while pending.
 */
export async function beginApproval(
  supabase: SupabaseClient,
  accountId: string,
  token: string,
  deps: ApprovalDeps
): Promise<{ challenge: string; keyIds: string[] }> {
  const row = await findRow(supabase, accountId, token);
  const now = (deps.now ?? (() => new Date()))();
  if (!isOpen(row, now)) throw new ClientError('This payment can no longer be approved.');

  const { data: keys, error: keysErr } = await supabase
    .from('custody_passkeys')
    .select('key_id')
    .eq('account_id', accountId)
    .eq('status', 'added');
  if (keysErr) throw new Error(keysErr.message);
  if (!keys?.length) throw new ClientError('This account has no passkey on its wallet.');

  const salt = BigInt('0x' + randomBytes(32).toString('hex')) || 1n;
  const { delegation } = buildOneOff({
    account: row.gator,
    delegate: row.delegate,
    symbol: row.symbol,
    to: row.to_address,
    amount: BigInt(row.amount),
    // The permission dies with the approval.
    expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
    salt,
  });
  const digest = delegationDigest(delegation);
  const { data: saved, error } = await supabase
    .from('custody_approvals')
    .update({
      salt: salt.toString(),
      signed_at: now.toISOString(),
      caveats: delegation.caveats,
      digest,
      updated_at: now.toISOString(),
    })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id');
  if (error) throw new Error(error.message);
  if (!saved?.length) throw new ClientError('This payment can no longer be approved.');
  return { challenge: b64url(ethers.getBytes(digest)), keyIds: keys.map((k) => String(k.key_id)) };
}

/**
 * Checks the passkey's answer, has the wallet confirm it on chain, and marks
 * the approval signed. A second answer finds it no longer pending.
 */
export async function finishApproval(
  supabase: SupabaseClient,
  accountId: string,
  token: string,
  answer: Omit<SignedAnswer, 'id'>,
  origin: string,
  deps: ApprovalDeps
): Promise<{ status: 'signed' }> {
  const row = await findRow(supabase, accountId, token);
  const now = (deps.now ?? (() => new Date()))();
  if (!isOpen(row, now)) throw new ClientError('This payment can no longer be approved.');
  if (!row.digest) throw new ClientError('Start the approval again.');

  const { data: key, error: keyErr } = await supabase
    .from('custody_passkeys')
    .select('key_id, x, y')
    .eq('account_id', accountId)
    .eq('key_id', String(answer.credentialId || ''))
    .eq('status', 'added')
    .maybeSingle();
  if (keyErr) throw new Error(keyErr.message);
  if (!key) throw new ClientError('That passkey is not on this account.');

  let signature: string;
  try {
    signature = encodeAssertion({
      keyId: key.key_id,
      key: { x: BigInt(key.x), y: BigInt(key.y) },
      digest: row.digest,
      origin,
      authenticatorData: fromB64url(String(answer.authenticatorData || '')),
      clientDataJSON: fromB64url(String(answer.clientDataJSON || '')),
      signature: fromB64url(String(answer.signature || '')),
    });
  } catch (err) {
    throw new ClientError(err instanceof Error ? err.message : 'The passkey signature could not be read.');
  }
  const verdict = await deps.call(row.gator, IS_VALID_SIGNATURE.encodeFunctionData('isValidSignature', [row.digest, signature]));
  if (String(verdict).slice(0, 10).toLowerCase() !== ERC1271_OK) throw new ClientError('Your wallet did not accept that signature.');

  const { data: done, error } = await supabase
    .from('custody_approvals')
    .update({ status: 'signed', signature: signature.toLowerCase(), updated_at: now.toISOString() })
    .eq('id', row.id)
    .eq('status', 'pending')
    .eq('digest', row.digest)
    .select('id');
  if (error) throw new Error(error.message);
  if (!done?.length) throw new ClientError('This payment can no longer be approved.');
  return { status: 'signed' };
}

/** Closes the approval before it is sent. Nothing moves. */
export async function cancelApproval(supabase: SupabaseClient, accountId: string, token: string, deps: ApprovalDeps): Promise<{ status: 'cancelled' }> {
  const row = await findRow(supabase, accountId, token);
  const now = (deps.now ?? (() => new Date()))();
  const { data, error } = await supabase
    .from('custody_approvals')
    .update({ status: 'cancelled', updated_at: now.toISOString() })
    .eq('id', row.id)
    .in('status', ['pending', 'signed'])
    .select('id');
  if (error) throw new Error(error.message);
  if (!data?.length) throw new ClientError('This payment can no longer be cancelled.');
  if (row.transfer_id) {
    await supabase
      .from('transfers')
      .update({ status: 'failed', error: 'Cancelled before it was sent. Nothing moved.' })
      .eq('id', row.transfer_id)
      .eq('status', 'pending');
  }
  return { status: 'cancelled' };
}
