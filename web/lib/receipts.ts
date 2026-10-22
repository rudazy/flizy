import { randomBytes } from 'crypto';
import { getSupabase } from './supabase.ts';
import { ClientError } from './apiError.ts';
import { assetSymbol } from './historyRow.ts';
import { displaySafeLabel } from './sanitize.ts';

/**
 * Shared payment receipts: /r/{token}.
 *
 * A receipt is private until one of the two people in it shares it
 * (supabase/migrations/20261021140000_transfer_receipts.sql). Sharing gives the
 * transfer a random token and the page is found by that token alone, so a
 * transfer id never opens a receipt.
 *
 * What a receipt shows is the minimum that proves a payment: amount, asset,
 * when, the network, the transaction, and what it was for. Each person is
 * named by @username only when they chose to be named on Scan
 * (accounts.scan_show_username); otherwise "A Flizy account", or a shortened
 * address for a wallet outside Flizy. The note is shown because the sharer
 * chose to share it; it is flattened like every other text from a person.
 */

export type Db = ReturnType<typeof getSupabase>;

/** 128 random bits, base64url. Matches transfers_receipt_token_format. */
export const RECEIPT_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RECEIPT_NOT_FOUND = 'That payment is not one you can share.';
export const RECEIPT_NOT_SETTLED = 'Only a confirmed payment has a receipt.';

type TransferRow = {
  id: string;
  account_id: string | null;
  to_address: string | null;
  status: string;
  kind: string | null;
  amount_eth: string | number | null;
  asset: string | null;
  token_address: string | null;
  tx_hash: string | null;
  created_at: string;
  note: string | null;
  receipt_token: string | null;
};

const TRANSFER_COLUMNS =
  'id, account_id, to_address, status, kind, amount_eth, asset, token_address, tx_hash, created_at, note, receipt_token';

function sameAddress(a: unknown, b: unknown): boolean {
  return Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * The token for one transfer, made the first time either party shares it.
 * Refuses anyone who is neither the sender nor the wallet that was paid, and
 * anything that is not a confirmed payment. A second share returns the same
 * token, so a link already sent keeps working.
 */
export async function shareReceipt(accountId: string, transferId: string, client?: Db): Promise<string> {
  const supabase = client ?? getSupabase();
  if (!UUID_RE.test(String(transferId || ''))) throw new ClientError(RECEIPT_NOT_FOUND);

  const { data: row, error } = await supabase.from('transfers').select(TRANSFER_COLUMNS).eq('id', transferId).maybeSingle();
  if (error) throw new Error(error.message);
  const t = row as TransferRow | null;
  if (!t) throw new ClientError(RECEIPT_NOT_FOUND);

  let party = t.account_id === accountId;
  if (!party) {
    const { data: me, error: meErr } = await supabase
      .from('accounts')
      .select('agent_wallet_address')
      .eq('id', accountId)
      .maybeSingle();
    if (meErr) throw new Error(meErr.message);
    party = sameAddress((me as { agent_wallet_address?: string } | null)?.agent_wallet_address, t.to_address);
  }
  // The same answer for "not yours" and "does not exist": a stranger learns
  // nothing about which ids are real.
  if (!party) throw new ClientError(RECEIPT_NOT_FOUND);
  if (String(t.kind || 'transfer') !== 'transfer') throw new ClientError(RECEIPT_NOT_FOUND);
  if (t.status !== 'confirmed') throw new ClientError(RECEIPT_NOT_SETTLED);
  if (t.receipt_token) return t.receipt_token;

  const token = randomBytes(16).toString('base64url');
  // Only fills an empty slot: when both parties share at once, one token wins
  // and both are handed it.
  const { error: upErr } = await supabase
    .from('transfers')
    .update({ receipt_token: token })
    .eq('id', t.id)
    .is('receipt_token', null);
  if (upErr) throw new Error(upErr.message);
  const { data: after, error: reErr } = await supabase.from('transfers').select('receipt_token').eq('id', t.id).maybeSingle();
  if (reErr) throw new Error(reErr.message);
  const stored = (after as { receipt_token?: string | null } | null)?.receipt_token;
  if (!stored || !RECEIPT_TOKEN_RE.test(stored)) throw new Error('receipt token was not stored');
  return stored;
}

export type Receipt = {
  amount: string;
  unit: string;
  from: string;
  to: string;
  /** Whether each side is a Flizy account or a wallet outside Flizy. */
  fromKind: PartyKind;
  toKind: PartyKind;
  note: string | null;
  at: string;
  network: string;
  txHash: string | null;
};

export type PartyKind = 'flizy' | 'wallet';

type Party = { username: string | null; scan_show_username: boolean | null };

function partyLabel(party: Party | null, address: string | null): string {
  if (party) return party.username && party.scan_show_username === true ? `@${party.username}` : 'A Flizy account';
  if (address && /^0x[0-9a-fA-F]{40}$/.test(address)) return `${address.slice(0, 6)}…${address.slice(-4)}`;
  return 'A wallet';
}

/** The public receipt behind a token, or null for any token that opens nothing. */
export async function loadReceipt(token: string, network: string, client?: Db): Promise<Receipt | null> {
  if (!RECEIPT_TOKEN_RE.test(String(token || ''))) return null;
  const supabase = client ?? getSupabase();
  const { data: row, error } = await supabase.from('transfers').select(TRANSFER_COLUMNS).eq('receipt_token', token).maybeSingle();
  if (error) throw new Error(error.message);
  const t = row as TransferRow | null;
  if (!t || t.status !== 'confirmed') return null;

  const partyCols = 'username, scan_show_username';
  const sender = t.account_id
    ? ((await supabase.from('accounts').select(partyCols).eq('id', t.account_id).maybeSingle()).data as Party | null)
    : null;
  const payee = t.to_address
    ? ((await supabase.from('accounts').select(partyCols).ilike('agent_wallet_address', t.to_address).maybeSingle()).data as Party | null)
    : null;

  return {
    amount: String(t.amount_eth ?? ''),
    unit: assetSymbol(t.token_address || t.asset || 'ETH'),
    from: partyLabel(sender, null),
    to: partyLabel(payee, t.to_address),
    fromKind: sender ? 'flizy' : 'wallet',
    toKind: payee ? 'flizy' : 'wallet',
    note: t.note ? displaySafeLabel(t.note, 80) || null : null,
    at: t.created_at,
    network,
    txHash: t.tx_hash,
  };
}
