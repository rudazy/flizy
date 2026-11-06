import { randomBytes } from 'crypto';
import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ClientError } from './apiError.ts';
import { buildDelegations, delegationDigest, ASSET_ORDER, EXPIRY_SECONDS, type AssetSymbol } from './custody/delegations.ts';
import { b64url, encodeAssertion, fromB64url } from './custody/webauthn.ts';
import type { CeremonyDeps } from './custody/ceremony.ts';
import type { Platform } from './apiPlatforms.ts';

/**
 * A platform's Flizy Pay API payout allowance, signed with the account's
 * passkey on the Developers page.
 *
 * One period allowance per asset Flizy enabled for the platform
 * (api_platform_limits), for that asset's daily maximum, delegated to the API
 * relayer (API_DELEGATE_ADDRESS here, API_RELAYER_KEY on the VPS) and valid 30
 * days. API payouts spend only through it (lib/api/allowanceSend.js), so the
 * chain enforces the daily amount whatever the server does.
 *
 * The same checks as the account's own permissions (web/lib/custody/ceremony.ts):
 * the passkey must already be on the account (Account, Security), every
 * signature is checked by the account itself on chain (ERC-1271) before it goes
 * live, and the passkey's user verification is the step-up.
 */

const SIGN_WINDOW_MS = 15 * 60 * 1000;
const ERC1271_OK = '0x1626ba7e';
const ACCOUNT_IFACE = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);

/** The API relayer's address, which every allowance names. */
function apiDelegate(env: Record<string, string | undefined> = process.env): string {
  const raw = String(env.API_DELEGATE_ADDRESS || '').trim();
  if (!ethers.isAddress(raw)) throw new ClientError('Payout allowances are not available yet.');
  return ethers.getAddress(raw);
}

function randomSalt(): bigint {
  const n = BigInt('0x' + randomBytes(32).toString('hex'));
  return n === 0n ? 1n : n;
}

type AllowanceRequest = { id: string; symbol: AssetSymbol; challenge: string };

/** Fresh allowances for every enabled asset, and the digests to sign. */
export async function beginAllowance(
  supabase: SupabaseClient,
  platform: Platform,
  deps: Pick<CeremonyDeps, 'gatorOf' | 'now'>,
  env: Record<string, string | undefined> = process.env
): Promise<{ keyIds: string[]; requests: AllowanceRequest[] }> {
  if (!platform.enabled) throw new ClientError('This platform is paused by Flizy.');
  const delegate = apiDelegate(env);
  const gator = await deps.gatorOf(platform.account_id);
  if (!gator || ethers.getAddress(gator) !== ethers.getAddress(platform.wallet_address)) {
    throw new ClientError("Your platform's payout wallet cannot take an allowance.");
  }

  const { data: limits, error: limErr } = await supabase
    .from('api_platform_limits')
    .select('symbol, daily_max')
    .eq('platform_id', platform.id);
  if (limErr) throw new Error(limErr.message);
  const periodAmounts: Partial<Record<AssetSymbol, bigint>> = {};
  for (const l of limits || []) {
    if ((ASSET_ORDER as readonly string[]).includes(l.symbol)) periodAmounts[l.symbol as AssetSymbol] = BigInt(l.daily_max);
  }
  if (!Object.keys(periodAmounts).length) throw new ClientError('Flizy has not enabled payouts in any asset for your platform yet.');

  const { data: keys, error: keysErr } = await supabase
    .from('custody_passkeys')
    .select('key_id')
    .eq('account_id', platform.account_id)
    .eq('status', 'added');
  if (keysErr) throw new Error(keysErr.message);
  if (!keys?.length) throw new ClientError('Add a passkey to your wallet first: Account, Security.');

  // Unsigned builds are dropped, so only this set can be signed.
  const { error: dropErr } = await supabase.from('api_allowances').delete().eq('platform_id', platform.id).eq('status', 'pending');
  if (dropErr) throw new Error(dropErr.message);

  const now = (deps.now ?? (() => new Date()))();
  const signedAt = Math.floor(now.getTime() / 1000);
  const salts = Object.fromEntries(Object.keys(periodAmounts).map((s) => [s, randomSalt()])) as Partial<Record<AssetSymbol, bigint>>;
  const built = buildDelegations({ account: gator, delegate, signedAt, salts, periodAmounts });
  const rows = built.map(({ symbol, delegation }) => ({
    platform_id: platform.id,
    account_id: platform.account_id,
    symbol,
    gator: delegation.delegator,
    delegate: delegation.delegate,
    salt: delegation.salt.toString(),
    period_amount: String(periodAmounts[symbol]),
    signed_at: new Date(signedAt * 1000).toISOString(),
    expires_at: new Date((signedAt + EXPIRY_SECONDS) * 1000).toISOString(),
    digest: delegationDigest(delegation),
    caveats: delegation.caveats,
    status: 'pending',
  }));
  const { data: inserted, error: insErr } = await supabase.from('api_allowances').insert(rows).select('id, symbol, digest');
  if (insErr) throw new Error(insErr.message);
  return {
    keyIds: keys.map((k) => String(k.key_id)),
    requests: (inserted ?? []).map((r) => ({ id: String(r.id), symbol: r.symbol as AssetSymbol, challenge: b64url(ethers.getBytes(String(r.digest))) })),
  };
}

export type AllowanceAnswer = { id: string; credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string };

/**
 * Each passkey answer becomes the account's signature, the account itself
 * confirms it on chain, and only then does it replace the live allowance for
 * that asset.
 */
export async function finishAllowance(
  supabase: SupabaseClient,
  platform: Platform,
  answers: AllowanceAnswer[],
  origin: string,
  deps: Pick<CeremonyDeps, 'gatorOf' | 'call' | 'notify' | 'now'>
): Promise<{ active: AssetSymbol[] }> {
  if (!platform.enabled) throw new ClientError('This platform is paused by Flizy.');
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > ASSET_ORDER.length) {
    throw new ClientError('Sign each allowance with your passkey.');
  }
  const gator = await deps.gatorOf(platform.account_id);
  if (!gator || ethers.getAddress(gator) !== ethers.getAddress(platform.wallet_address)) {
    throw new ClientError("Your platform's payout wallet cannot take an allowance.");
  }
  const now = (deps.now ?? (() => new Date()))();

  const prepared: Array<{ id: string; symbol: AssetSymbol; signature: string }> = [];
  for (const a of answers) {
    const { data: row, error } = await supabase
      .from('api_allowances')
      .select('id, symbol, gator, digest, signed_at, status')
      .eq('id', String(a?.id || ''))
      .eq('platform_id', platform.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row || row.status !== 'pending') throw new ClientError('That allowance is no longer waiting for a signature. Start again.');
    if (now.getTime() - new Date(row.signed_at).getTime() > SIGN_WINDOW_MS) throw new ClientError('The allowance took too long to sign. Start again.');
    if (ethers.getAddress(row.gator) !== ethers.getAddress(gator)) throw new ClientError('That allowance is for another wallet.');

    const { data: key, error: keyErr } = await supabase
      .from('custody_passkeys')
      .select('key_id, x, y')
      .eq('account_id', platform.account_id)
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
    const answer = await deps.call(gator, ACCOUNT_IFACE.encodeFunctionData('isValidSignature', [row.digest, signature]));
    if (String(answer).slice(0, 10).toLowerCase() !== ERC1271_OK) throw new ClientError('Your wallet did not accept that signature.');
    prepared.push({ id: row.id, symbol: row.symbol as AssetSymbol, signature: signature.toLowerCase() });
  }

  const active: AssetSymbol[] = [];
  for (const p of prepared) {
    const { error: oldErr } = await supabase
      .from('api_allowances')
      .update({ status: 'replaced' })
      .eq('platform_id', platform.id)
      .eq('symbol', p.symbol)
      .eq('status', 'active');
    if (oldErr) throw new Error(oldErr.message);
    const { data: done, error: upErr } = await supabase
      .from('api_allowances')
      .update({ status: 'active', signature: p.signature, activated_at: now.toISOString() })
      .eq('id', p.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (upErr) throw new Error(upErr.message);
    if (done) active.push(p.symbol);
  }
  if (active.length) {
    await deps.notify(
      platform.account_id,
      `Your passkey signed the Flizy Pay API payout allowance (${active.join(', ')}). API payouts can spend up to it each day for 30 days.`
    );
  }
  return { active };
}

type AllowanceView = { symbol: AssetSymbol; periodAmount: string; expiresAt: string; activatedAt: string | null };

/** The live allowances, for the Developers page. */
export async function liveAllowances(supabase: SupabaseClient, platformId: string): Promise<AllowanceView[]> {
  const { data, error } = await supabase
    .from('api_allowances')
    .select('symbol, period_amount, expires_at, activated_at')
    .eq('platform_id', platformId)
    .eq('status', 'active');
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({
    symbol: r.symbol as AssetSymbol,
    periodAmount: String(r.period_amount),
    expiresAt: String(r.expires_at),
    activatedAt: (r.activated_at as string | null) ?? null,
  }));
}
