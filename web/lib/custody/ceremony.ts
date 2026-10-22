/**
 * Secure this account, steps 1 and 2 of the sequence described in
 * lib/custody/delegations.js: a passkey made on flizy.app joins the account's HybridDeleGator
 * as a P-256 key (Flizy, still owner, runs addKey on the account itself), then
 * that passkey signs Flizy's three bounded delegations. Ownership does not move
 * here; that is a later step with its own hold.
 *
 * Only accounts named in CUSTODY_PILOT_ACCOUNTS may start. Every step takes
 * the account from the session, never from the body, and the routes ask for
 * the account password before anything is added to the account.
 *
 * Chain calls arrive as `deps` so every branch can be tested without a node.
 */

import { randomBytes } from 'crypto';
import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ClientError } from '../apiError.ts';
import { publicMail } from '../publicMail.ts';
import { buildDelegations, delegationDigest, ASSET_ORDER, EXPIRY_SECONDS, type AssetSymbol } from './delegations.ts';
import { b64url, checkClientData, encodeAssertion, fromB64url, publicKeyFromSpki } from './webauthn.ts';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Delegations built but not signed within this window are refused; the page starts over. */
const SIGN_WINDOW_MS = 15 * 60 * 1000;
const MAX_PASSKEYS = 3;
const ES256 = -7;
const ERC1271_OK = '0x1626ba7e';

const ACCOUNT_IFACE = new ethers.Interface([
  'function addKey(string _keyId, uint256 _x, uint256 _y)',
  'function getKey(string _keyId) view returns (uint256 x_, uint256 y_)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);

export const NOT_IN_PILOT = 'Securing an account is not open yet.';

export type CeremonyDeps = {
  /** The account's HybridDeleGator, or null when its wallet is not one. */
  gatorOf: (accountId: string) => Promise<string | null>;
  /** Runs a call as the account itself through the owner's UserOp. */
  execAsAccount: (p: { accountId: string; target: string; data: string; onBroadcast: (txHash: string) => Promise<void> }) => Promise<{ txHash: string }>;
  /** A read-only eth_call. */
  call: (to: string, data: string) => Promise<string>;
  /** Tells every linked channel; never throws. */
  notify: (accountId: string, body: string) => Promise<void>;
  now?: () => Date;
};

function pilotAccounts(): Set<string> {
  return new Set(
    String(process.env.CUSTODY_PILOT_ACCOUNTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function inPilot(accountId: string): boolean {
  return Boolean(accountId) && pilotAccounts().has(String(accountId).toLowerCase());
}

/** The Flizy relayer each delegation names. Required before any delegation is built. */
export function custodyDelegate(): string {
  const raw = String(process.env.CUSTODY_DELEGATE_ADDRESS || '').trim();
  if (!ethers.isAddress(raw) || /^0x0{40}$/i.test(raw)) {
    throw new Error('CUSTODY_DELEGATE_ADDRESS must be set to the relayer address');
  }
  return ethers.getAddress(raw);
}

function assertPilot(accountId: string) {
  if (!inPilot(accountId)) throw new ClientError(NOT_IN_PILOT);
}

const hex32 = (n: bigint) => ethers.toBeHex(n, 32);

// ---------------------------------------------------------------------------
// Step 1: a passkey on the account
// ---------------------------------------------------------------------------

export type PasskeyOptions = {
  challenge: string;
  rpName: string;
  userId: string;
  userName: string;
  excludeKeyIds: string[];
  timeoutMs: number;
};

/** A one-time challenge and the options navigator.credentials.create() needs. */
export async function beginPasskey(supabase: SupabaseClient, accountId: string, userName: string, deps: CeremonyDeps): Promise<PasskeyOptions> {
  assertPilot(accountId);
  if (!(await deps.gatorOf(accountId))) throw new ClientError("This account's wallet cannot take a passkey yet.");

  const { data: keys, error: keysErr } = await supabase.from('custody_passkeys').select('key_id, status').eq('account_id', accountId);
  if (keysErr) throw new Error(keysErr.message);
  const added = (keys ?? []).filter((k) => k.status === 'added');
  if (added.length >= MAX_PASSKEYS) throw new ClientError(`An account can hold ${MAX_PASSKEYS} passkeys.`);

  const now = (deps.now ?? (() => new Date()))();
  const challenge = b64url(randomBytes(32));
  const { error } = await supabase.from('custody_challenges').insert({
    account_id: accountId,
    purpose: 'passkey_create',
    challenge,
    expires_at: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(),
  });
  if (error) throw new Error(error.message);

  return {
    challenge,
    rpName: 'Flizy',
    // Opaque and stable per account: no email, phone or id in the authenticator.
    userId: b64url(ethers.getBytes(ethers.id(`flizy:passkey-user:${accountId}`))),
    userName: userName.slice(0, 64) || 'Flizy account',
    excludeKeyIds: added.map((k) => String(k.key_id)),
    timeoutMs: CHALLENGE_TTL_MS,
  };
}

export type NewPasskey = {
  credentialId: string;
  clientDataJSON: string;
  publicKey: string;
  publicKeyAlgorithm: number;
};

/**
 * Checks the browser's create() answer, burns its challenge, then adds the key
 * to the account on chain and confirms the account stored that exact point.
 */
export async function finishPasskey(
  supabase: SupabaseClient,
  accountId: string,
  answer: NewPasskey,
  origin: string,
  deps: CeremonyDeps
): Promise<{ passkeyId: string; txHash: string }> {
  assertPilot(accountId);
  const credentialId = String(answer?.credentialId || '');
  if (!/^[A-Za-z0-9_-]{16,1366}$/.test(credentialId)) throw new ClientError('The passkey could not be read.');
  if (answer.publicKeyAlgorithm !== ES256) throw new ClientError('This device made a passkey Flizy cannot use. Try another device.');

  const clientDataJSON = fromB64url(String(answer.clientDataJSON || ''));
  let sent: string;
  try {
    sent = JSON.parse(clientDataJSON.toString('utf8'))?.challenge;
  } catch {
    throw new ClientError('The passkey could not be read.');
  }
  if (typeof sent !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sent)) throw new ClientError('The passkey could not be read.');

  const now = (deps.now ?? (() => new Date()))();
  // Burn the challenge in the same statement that finds it: a second answer finds nothing.
  const { data: burned, error: burnErr } = await supabase
    .from('custody_challenges')
    .update({ used_at: now.toISOString() })
    .eq('challenge', sent)
    .eq('account_id', accountId)
    .eq('purpose', 'passkey_create')
    .is('used_at', null)
    .gt('expires_at', now.toISOString())
    .select('id')
    .maybeSingle();
  if (burnErr) throw new Error(burnErr.message);
  if (!burned) throw new ClientError('That passkey request has expired. Start again.');

  try {
    checkClientData(clientDataJSON, { type: 'webauthn.create', challenge: sent, origin });
  } catch (err) {
    throw new ClientError(err instanceof Error ? err.message : 'The passkey could not be read.');
  }
  let point;
  try {
    point = publicKeyFromSpki(fromB64url(String(answer.publicKey || '')));
  } catch (err) {
    throw new ClientError(err instanceof Error ? err.message : 'The passkey could not be read.');
  }

  const gator = await deps.gatorOf(accountId);
  if (!gator) throw new ClientError("This account's wallet cannot take a passkey yet.");

  const { data: row, error: insErr } = await supabase
    .from('custody_passkeys')
    .insert({ account_id: accountId, key_id: credentialId, x: hex32(point.x), y: hex32(point.y), status: 'pending' })
    .select('id')
    .single();
  if (insErr) {
    if (/duplicate|unique/i.test(insErr.message)) throw new ClientError('That passkey is already on an account.');
    throw new Error(insErr.message);
  }

  let txHash = '';
  let broadcast = false;
  try {
    ({ txHash } = await deps.execAsAccount({
      accountId,
      target: gator,
      data: ACCOUNT_IFACE.encodeFunctionData('addKey', [credentialId, point.x, point.y]),
      onBroadcast: async (hash) => {
        const { error } = await supabase.from('custody_passkeys').update({ add_tx_hash: hash }).eq('id', row.id);
        if (error) throw new Error(error.message);
        broadcast = true;
      },
    }));
  } catch (err) {
    // Sent but unconfirmed: the key may still land. The row stays pending and
    // passkeyStatus settles it from the account itself.
    if (broadcast && (await accountHolds(gator, credentialId, point, deps)) === false) {
      throw new ClientError('Your passkey was sent to your wallet but is not confirmed yet. Check again in a minute.');
    }
    if (!broadcast) {
      await supabase.from('custody_passkeys').update({ status: 'failed' }).eq('id', row.id);
      throw err;
    }
  }

  // The account must now hold this exact point under this id, or the step did not happen.
  if (!(await accountHolds(gator, credentialId, point, deps))) {
    await supabase.from('custody_passkeys').update({ status: 'failed' }).eq('id', row.id);
    throw new Error('addKey did not store the passkey');
  }
  await markAdded(supabase, accountId, row.id, now, deps);
  return { passkeyId: row.id, txHash };
}

async function accountHolds(gator: string, keyId: string, point: { x: bigint; y: bigint }, deps: CeremonyDeps): Promise<boolean> {
  const [x, y] = ACCOUNT_IFACE.decodeFunctionResult('getKey', await deps.call(gator, ACCOUNT_IFACE.encodeFunctionData('getKey', [keyId])));
  return x === point.x && y === point.y;
}

async function markAdded(supabase: SupabaseClient, accountId: string, passkeyId: string, now: Date, deps: CeremonyDeps) {
  const { data, error } = await supabase
    .from('custody_passkeys')
    .update({ status: 'added', added_at: now.toISOString() })
    .eq('id', passkeyId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) {
    await deps.notify(accountId, `A passkey was added to your Flizy wallet. If this was not you, pause your account on flizy.app and write to ${publicMail('contact').address}.`);
  }
}

export type CustodyStatus = {
  pilot: boolean;
  walletReady: boolean;
  passkeys: Array<{ status: string; addedAt: string | null }>;
  delegations: Array<{ symbol: AssetSymbol; expiresAt: string }>;
};

/**
 * What the account has so far. A passkey whose transaction was sent but not
 * confirmed is settled here, from what the account itself holds.
 */
export async function custodyStatus(supabase: SupabaseClient, accountId: string, deps: CeremonyDeps): Promise<CustodyStatus> {
  if (!inPilot(accountId)) return { pilot: false, walletReady: false, passkeys: [], delegations: [] };
  const gator = await deps.gatorOf(accountId);
  const now = (deps.now ?? (() => new Date()))();

  const { data: keys, error: keysErr } = await supabase
    .from('custody_passkeys')
    .select('id, key_id, x, y, status, add_tx_hash, added_at')
    .eq('account_id', accountId);
  if (keysErr) throw new Error(keysErr.message);
  for (const k of keys ?? []) {
    if (gator && k.status === 'pending' && k.add_tx_hash && (await accountHolds(gator, k.key_id, { x: BigInt(k.x), y: BigInt(k.y) }, deps))) {
      await markAdded(supabase, accountId, k.id, now, deps);
      k.status = 'added';
      k.added_at = now.toISOString();
    }
  }

  const { data: live, error: liveErr } = await supabase
    .from('custody_delegations')
    .select('symbol, expires_at')
    .eq('account_id', accountId)
    .eq('status', 'active');
  if (liveErr) throw new Error(liveErr.message);

  return {
    pilot: true,
    walletReady: Boolean(gator),
    passkeys: (keys ?? []).filter((k) => k.status !== 'failed').map((k) => ({ status: String(k.status), addedAt: k.added_at ?? null })),
    delegations: (live ?? [])
      .filter((d) => new Date(d.expires_at).getTime() > now.getTime())
      .map((d) => ({ symbol: d.symbol as AssetSymbol, expiresAt: String(d.expires_at) })),
  };
}

// ---------------------------------------------------------------------------
// Step 2: the passkey signs Flizy's bounded delegations
// ---------------------------------------------------------------------------

export type DelegationRequest = { id: string; symbol: AssetSymbol; challenge: string };

function randomSalt(): bigint {
  const n = BigInt('0x' + randomBytes(32).toString('hex'));
  return n === 0n ? 1n : n;
}

/** Builds fresh delegations for every asset and returns the digests to sign. */
export async function beginDelegations(
  supabase: SupabaseClient,
  accountId: string,
  deps: CeremonyDeps
): Promise<{ keyIds: string[]; requests: DelegationRequest[] }> {
  assertPilot(accountId);
  const gator = await deps.gatorOf(accountId);
  if (!gator) throw new ClientError("This account's wallet cannot take a passkey yet.");
  const delegate = custodyDelegate();

  const { data: keys, error: keysErr } = await supabase
    .from('custody_passkeys')
    .select('key_id')
    .eq('account_id', accountId)
    .eq('status', 'added');
  if (keysErr) throw new Error(keysErr.message);
  if (!keys?.length) throw new ClientError('Add a passkey first.');

  // Earlier unsigned builds are deleted, so only this set can be signed and
  // repeated calls never pile rows up. A signed one is kept, as 'replaced'.
  const { error: dropErr } = await supabase
    .from('custody_delegations')
    .delete()
    .eq('account_id', accountId)
    .eq('status', 'pending');
  if (dropErr) throw new Error(dropErr.message);

  const now = (deps.now ?? (() => new Date()))();
  const signedAt = Math.floor(now.getTime() / 1000);
  const salts = Object.fromEntries(ASSET_ORDER.map((s) => [s, randomSalt()])) as Record<AssetSymbol, bigint>;
  const built = buildDelegations({ account: gator, delegate, signedAt, salts });

  const rows = built.map(({ symbol, delegation }) => ({
    account_id: accountId,
    symbol,
    gator: delegation.delegator,
    delegate: delegation.delegate,
    salt: delegation.salt.toString(),
    signed_at: new Date(signedAt * 1000).toISOString(),
    expires_at: new Date((signedAt + EXPIRY_SECONDS) * 1000).toISOString(),
    digest: delegationDigest(delegation),
    caveats: delegation.caveats,
    status: 'pending',
  }));
  const { data: inserted, error: insErr } = await supabase.from('custody_delegations').insert(rows).select('id, symbol, digest');
  if (insErr) throw new Error(insErr.message);

  return {
    keyIds: keys.map((k) => String(k.key_id)),
    requests: (inserted ?? []).map((r) => ({
      id: String(r.id),
      symbol: r.symbol as AssetSymbol,
      challenge: b64url(ethers.getBytes(String(r.digest))),
    })),
  };
}

export type SignedAnswer = {
  id: string;
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
};

/**
 * Turns each passkey answer into the account's signature, has the account
 * itself confirm it (ERC-1271 on chain), and only then makes it the live
 * delegation for that asset.
 */
export async function finishDelegations(
  supabase: SupabaseClient,
  accountId: string,
  answers: SignedAnswer[],
  origin: string,
  deps: CeremonyDeps
): Promise<{ active: AssetSymbol[] }> {
  assertPilot(accountId);
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > ASSET_ORDER.length) {
    throw new ClientError('Sign each permission with your passkey.');
  }
  const gator = await deps.gatorOf(accountId);
  if (!gator) throw new ClientError("This account's wallet cannot take a passkey yet.");
  const now = (deps.now ?? (() => new Date()))();

  const prepared: Array<{ id: string; symbol: AssetSymbol; signature: string }> = [];
  for (const a of answers) {
    const { data: row, error } = await supabase
      .from('custody_delegations')
      .select('id, symbol, gator, digest, signed_at, status')
      .eq('id', String(a?.id || ''))
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row || row.status !== 'pending') throw new ClientError('That permission is no longer waiting for a signature. Start again.');
    if (now.getTime() - new Date(row.signed_at).getTime() > SIGN_WINDOW_MS) {
      throw new ClientError('These permissions took too long to sign. Start again.');
    }
    if (ethers.getAddress(row.gator) !== ethers.getAddress(gator)) throw new ClientError('That permission is for another wallet.');

    const { data: key, error: keyErr } = await supabase
      .from('custody_passkeys')
      .select('key_id, x, y')
      .eq('account_id', accountId)
      .eq('key_id', String(a.credentialId || ''))
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
        authenticatorData: fromB64url(String(a.authenticatorData || '')),
        clientDataJSON: fromB64url(String(a.clientDataJSON || '')),
        signature: fromB64url(String(a.signature || '')),
      });
    } catch (err) {
      throw new ClientError(err instanceof Error ? err.message : 'The passkey signature could not be read.');
    }

    // The account is the judge: the same check DelegationManager makes at redeem time.
    const answer = await deps.call(gator, ACCOUNT_IFACE.encodeFunctionData('isValidSignature', [row.digest, signature]));
    if (String(answer).slice(0, 10).toLowerCase() !== ERC1271_OK) {
      throw new ClientError('Your wallet did not accept that signature.');
    }
    prepared.push({ id: row.id, symbol: row.symbol as AssetSymbol, signature: signature.toLowerCase() });
  }

  const active: AssetSymbol[] = [];
  for (const p of prepared) {
    const { error: oldErr } = await supabase
      .from('custody_delegations')
      .update({ status: 'replaced' })
      .eq('account_id', accountId)
      .eq('symbol', p.symbol)
      .eq('status', 'active');
    if (oldErr) throw new Error(oldErr.message);
    const { data: done, error: upErr } = await supabase
      .from('custody_delegations')
      .update({ status: 'active', signature: p.signature, activated_at: now.toISOString() })
      .eq('id', p.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (upErr) throw new Error(upErr.message);
    if (done) active.push(p.symbol);
  }

  if (active.length) {
    await deps.notify(accountId, `Your passkey signed Flizy's daily spending permissions (${active.join(', ')}). They expire in 30 days.`);
  }
  return { active };
}
