import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import { getSupabase } from './supabase.ts';
import { ClientError } from './apiError.ts';
import { getWebChain } from './webChain.ts';
import { closureOf, isMissingClosureColumn } from './accountClosure.ts';
import { listedBySymbol } from './listedTokens.ts';

/**
 * One-tap faucet: GIWA Sepolia test ETH, or Flizy Test USD (tUSD), from a
 * Flizy-run dispenser wallet to the signed-in account's own Flizy wallet.
 *
 * The rules live here and in supabase/migrations/20261010120000_faucet_claims.sql
 * and 20261021120000_faucet_test_usd.sql, never in the browser:
 *   - the amount and the cooldown are constants on this side, one pair per
 *     asset; the request only names which asset;
 *   - the destination is the account's stored wallet, never an address from
 *     the request;
 *   - try_faucet_claim reserves the claim under a per-account lock, so a
 *     double click or two tabs produce one claim; each asset has its own wait;
 *   - one send at a time leaves the dispenser wallet (faucet_signer_lock), so
 *     two people claiming at once cannot race on its nonce, whichever asset
 *     each one asked for.
 *
 * The dispenser key is FAUCET_PRIVATE_KEY and nothing else. It never falls back
 * to the ops key, so a faucet bug cannot spend the gas the rest of Flizy runs
 * on, and a testnet guard refuses to run it on any other chain.
 */

export type Db = ReturnType<typeof getSupabase>;

export const FAUCET_AMOUNT_ETH = '0.02';
export const FAUCET_COOLDOWN_HOURS = 72;
export const FAUCET_AMOUNT_TUSD = '100';
export const FAUCET_COOLDOWN_HOURS_TUSD = 24;
/** GIWA Sepolia. The faucet hands out test money and runs nowhere else. */
export const FAUCET_CHAIN_ID = 91342;

export type FaucetAsset = 'ETH' | 'TUSD';

/** What one claim of an asset is: how much, in which smallest unit, and how long until the next. */
type Drop = {
  asset: FaucetAsset;
  /** How the asset prints. */
  unit: string;
  amount: string;
  units: bigint;
  cooldownHours: number;
  /** The token contract; null for native ETH. */
  token: string | null;
};

const TUSD = listedBySymbol('TUSD');
if (!TUSD) throw new Error('TUSD is missing from the listed tokens');

const DROPS: Record<FaucetAsset, Drop> = {
  ETH: {
    asset: 'ETH',
    unit: 'ETH',
    amount: FAUCET_AMOUNT_ETH,
    units: ethers.parseEther(FAUCET_AMOUNT_ETH),
    cooldownHours: FAUCET_COOLDOWN_HOURS,
    token: null,
  },
  TUSD: {
    asset: 'TUSD',
    unit: TUSD.label || TUSD.symbol,
    amount: FAUCET_AMOUNT_TUSD,
    units: ethers.parseUnits(FAUCET_AMOUNT_TUSD, TUSD.decimals),
    cooldownHours: FAUCET_COOLDOWN_HOURS_TUSD,
    token: ethers.getAddress(TUSD.address),
  },
};

export const FAUCET_UNKNOWN_ASSET = 'The faucet hands out ETH and tUSD only.';

/** The asset a request names. Nothing named is ETH, the faucet's first asset. */
export function normalizeFaucetAsset(raw: unknown): FaucetAsset {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s || s === 'ETH') return 'ETH';
  if (s === 'TUSD' || s === 'USD') return 'TUSD';
  throw new ClientError(FAUCET_UNKNOWN_ASSET);
}

/** Kept back for the transfer's own gas, so the dispenser never sends what it cannot pay for. */
const GAS_RESERVE_WEI = ethers.parseEther('0.0005');
const LOCK_WAIT_MS = 10000;
const LOCK_POLL_MS = 500;
const CONFIRM_TIMEOUT_MS = 20000;
const ERROR_MAX = 300;

export const FAUCET_NOT_SET_UP = 'The faucet is not set up yet.';
export const FAUCET_EMPTY = 'The faucet is empty right now. Try again later.';
export const FAUCET_BUSY = 'The faucet is busy. Try again in a moment.';
export const FAUCET_SEND_FAILED = 'Could not send the test ETH. Try again.';
export const FAUCET_SEND_FAILED_TUSD = 'Could not send the test tUSD. Try again.';
export const FAUCET_COOLDOWN = 'You have already claimed. Come back when the timer ends.';

/** A transaction the dispenser sent, and a way to learn how it ended. */
export type FaucetSent = {
  hash: string;
  /** confirmed, reverted, or timeout when no receipt arrived in time. */
  wait(timeoutMs: number): Promise<'confirmed' | 'reverted' | 'timeout'>;
};

/** What sending needs from the chain. Injectable, so the rules are testable without a network. */
export type FaucetSender = {
  /** The dispenser's ETH balance, in wei. */
  balance(): Promise<bigint>;
  send(to: string, valueWei: bigint): Promise<FaucetSent>;
  /** The dispenser's balance of one token, in its smallest unit. */
  tokenBalance(token: string): Promise<bigint>;
  sendToken(token: string, to: string, units: bigint): Promise<FaucetSent>;
};

function faucetKey(): string | null {
  const key = String(process.env.FAUCET_PRIVATE_KEY || '').trim();
  if (!key || /your_|placeholder/i.test(key)) return null;
  return key;
}

/** Whether a dispenser key is configured. Says nothing about the key itself. */
export function faucetConfigured(): boolean {
  return faucetKey() !== null;
}

/** The real sender: the dispenser wallet on GIWA Sepolia. */
export function getFaucetSender(): FaucetSender {
  const key = faucetKey();
  if (!key) throw new ClientError(FAUCET_NOT_SET_UP);
  const chain = getWebChain();
  if (chain.chainId !== FAUCET_CHAIN_ID) {
    throw new Error(`The faucet only runs on GIWA Sepolia (chain id ${FAUCET_CHAIN_ID}), not ${chain.chainId}.`);
  }
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, FAUCET_CHAIN_ID, { staticNetwork: true });
  const wallet = new ethers.Wallet(key, provider);
  const erc20 = (token: string) =>
    new ethers.Contract(
      token,
      ['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)'],
      wallet
    );

  // The RPC is asked which chain it serves before anything is signed; the
  // static network above only stops ethers asking on every call.
  const assertChain = async () => {
    const network = await provider.send('eth_chainId', []);
    if (Number(network) !== FAUCET_CHAIN_ID) {
      throw new Error(`The RPC serves chain ${Number(network)}, not GIWA Sepolia.`);
    }
  };
  const tracked = (hash: string): FaucetSent => ({
    hash,
    async wait(timeoutMs) {
      try {
        const receipt = await provider.waitForTransaction(hash, 1, timeoutMs);
        if (!receipt) return 'timeout';
        return receipt.status === 1 ? 'confirmed' : 'reverted';
      } catch (err) {
        if (ethers.isError(err, 'TIMEOUT')) return 'timeout';
        throw err;
      }
    },
  });

  return {
    balance: () => provider.getBalance(wallet.address),
    async send(to, valueWei) {
      await assertChain();
      const tx = await wallet.sendTransaction({ to, value: valueWei });
      return tracked(tx.hash);
    },
    async tokenBalance(token) {
      return BigInt(await erc20(token).balanceOf(wallet.address));
    },
    async sendToken(token, to, units) {
      await assertChain();
      const tx = await erc20(token).transfer(to, units);
      return tracked(tx.hash);
    },
  };
}

type AccountRow = {
  id: string;
  username: string | null;
  email_verified_at: string | null;
  agent_wallet_address: string | null;
  deactivated_at?: string | null;
  deleted_at?: string | null;
};

type ClaimRow = {
  id: string;
  status: 'pending' | 'sent' | 'confirmed' | 'failed';
  tx_hash: string | null;
  created_at: string;
  sent_at: string | null;
  /** Absent on a database without 20261021120000_faucet_test_usd.sql, where every claim is ETH. */
  asset?: FaucetAsset | null;
};

/** Why this account cannot claim, and the screen that fixes it. Null when it can. */
function ineligibility(account: AccountRow | null): { reason: string; fix: 'profile' | null } | null {
  if (!account || closureOf(account) !== 'open') return { reason: 'This account cannot claim.', fix: null };
  if (!account.email_verified_at) return { reason: 'Verify your email to claim.', fix: 'profile' };
  if (!account.username) return { reason: 'Choose a username to claim.', fix: 'profile' };
  if (!account.agent_wallet_address || !ethers.isAddress(account.agent_wallet_address)) {
    return { reason: 'Your Flizy wallet is not ready yet.', fix: null };
  }
  return null;
}

const ACCOUNT_COLUMNS = 'id, username, email_verified_at, agent_wallet_address';

/**
 * The closure columns are read when the database has them. A database without
 * the account closure migration is read without them, the same fallback the
 * session check in lib/cookies.ts uses; that check already refuses a closed
 * account's session before any route gets here.
 */
async function loadAccount(accountId: string, supabase: Db): Promise<AccountRow | null> {
  const wide = await supabase
    .from('accounts')
    .select(`${ACCOUNT_COLUMNS}, deactivated_at, deleted_at`)
    .eq('id', accountId)
    .maybeSingle();
  if (!wide.error) return (wide.data as AccountRow | null) || null;
  if (!isMissingClosureColumn(wide.error)) throw new Error(wide.error.message);

  const narrow = await supabase.from('accounts').select(ACCOUNT_COLUMNS).eq('id', accountId).maybeSingle();
  if (narrow.error) throw new Error(narrow.error.message);
  return (narrow.data as AccountRow | null) || null;
}

const CLAIM_COLUMNS = 'id, status, tx_hash, created_at, sent_at';

function isMissingAssetColumn(error: { message?: string } | null): boolean {
  const m = String(error?.message || '');
  return /\basset\b/i.test(m) && /column|schema cache/i.test(m);
}

/**
 * The claim that holds this asset's cooldown: the newest one of that asset
 * that did not fail and was not abandoned.
 *
 * The asset is matched here rather than in the query so a row written before
 * the asset column existed reads as ETH, which it is. A database without that
 * column is read without it, and then holds ETH claims only.
 */
async function lastCountingClaim(accountId: string, supabase: Db, now: number, drop: Drop): Promise<ClaimRow | null> {
  const since = new Date(now - drop.cooldownHours * 3600e3).toISOString();
  const read = (columns: string) =>
    supabase
      .from('faucet_claims')
      .select(columns)
      .eq('account_id', accountId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50);
  let { data, error } = await read(`${CLAIM_COLUMNS}, asset`);
  if (error && isMissingAssetColumn(error)) {
    if (drop.asset !== 'ETH') return null;
    ({ data, error } = await read(CLAIM_COLUMNS));
  }
  if (error) throw new Error(error.message);
  for (const row of (data || []) as unknown as ClaimRow[]) {
    if ((row.asset || 'ETH') !== drop.asset) continue;
    if (row.status === 'failed') continue;
    // The same rule try_faucet_claim applies: a pending claim with no
    // transaction after five minutes belongs to a request that died.
    if (row.status === 'pending' && !row.tx_hash && new Date(row.created_at).getTime() < now - 5 * 60e3) continue;
    return row;
  }
  return null;
}

function txUrl(hash: string | null): string | null {
  return hash ? `${getWebChain().explorerBaseUrl}/tx/${hash}` : null;
}

export type FaucetStatus = {
  asset: FaucetAsset;
  /** How the asset prints: ETH or tUSD. */
  unit: string;
  /** One claim, in `unit`. */
  amount: string;
  /** The same figure as `amount`. Named for the ETH-only faucet; kept for its callers. */
  amountEth: string;
  cooldownHours: number;
  ready: boolean;
  eligible: boolean;
  reason: string | null;
  fix: 'profile' | null;
  username: string | null;
  /** When the next claim opens. Null when one can be claimed now. */
  nextClaimAt: string | null;
  lastClaim: { status: ClaimRow['status']; txUrl: string | null; at: string } | null;
};

export async function faucetStatus(
  accountId: string,
  client?: Db,
  now = Date.now(),
  asset: FaucetAsset = 'ETH'
): Promise<FaucetStatus> {
  const drop = DROPS[asset];
  const supabase = client ?? getSupabase();
  const account = await loadAccount(accountId, supabase);
  const blocked = ineligibility(account);
  const last = account ? await lastCountingClaim(accountId, supabase, now, drop) : null;
  const ready = faucetConfigured();
  return {
    asset,
    unit: drop.unit,
    amount: drop.amount,
    amountEth: drop.amount,
    cooldownHours: drop.cooldownHours,
    ready,
    eligible: ready && !blocked,
    reason: !ready ? FAUCET_NOT_SET_UP : blocked?.reason ?? null,
    fix: blocked?.fix ?? null,
    username: account?.username ?? null,
    nextClaimAt: last ? new Date(new Date(last.created_at).getTime() + drop.cooldownHours * 3600e3).toISOString() : null,
    lastClaim: last ? { status: last.status, txUrl: txUrl(last.tx_hash), at: last.created_at } : null,
  };
}

export type FaucetReceipt = {
  asset: FaucetAsset;
  unit: string;
  amount: string;
  /** The same figure as `amount`. Named for the ETH-only faucet; kept for its callers. */
  amountEth: string;
  status: 'confirmed' | 'sent';
  txHash: string;
  txUrl: string;
  nextClaimAt: string;
};

async function markClaim(supabase: Db, claimId: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from('faucet_claims').update(patch).eq('id', claimId);
  if (error) console.error(`[faucet] could not update claim ${claimId}: ${error.message}`);
}

async function takeSignerLock(supabase: Db, holder: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const { data, error } = await supabase.rpc('try_faucet_signer_lock', { p_holder: holder });
    if (error) throw new Error(error.message);
    if (data === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/**
 * A failure as stored and logged. Addresses are dropped first: ethers puts the
 * RPC URL in its errors, and a provider URL can carry an API key.
 */
export function shortError(err: unknown): string {
  return String(err instanceof Error ? err.message : err)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .slice(0, ERROR_MAX);
}

/**
 * Claim once. Sends exactly one drop of the asset (FAUCET_AMOUNT_ETH, or
 * FAUCET_AMOUNT_TUSD) to the account's stored wallet.
 *
 * Anything that fails before a transaction exists marks the claim failed, which
 * frees it to be tried again. A transaction that was sent but not confirmed in
 * time keeps the cooldown: it may still land, and paying twice is the worse
 * mistake.
 */
export async function claimFaucet(
  accountId: string,
  deps: { client?: Db; sender?: FaucetSender; asset?: FaucetAsset } = {}
): Promise<FaucetReceipt> {
  const drop = DROPS[deps.asset ?? 'ETH'];
  const sendFailed = drop.asset === 'ETH' ? FAUCET_SEND_FAILED : FAUCET_SEND_FAILED_TUSD;
  const supabase = deps.client ?? getSupabase();
  if (!deps.sender && !faucetConfigured()) throw new ClientError(FAUCET_NOT_SET_UP);

  const account = await loadAccount(accountId, supabase);
  const blocked = ineligibility(account);
  if (blocked || !account) throw new ClientError(blocked?.reason || 'This account cannot claim.');
  const to = ethers.getAddress(String(account.agent_wallet_address));

  // ETH reserves through the four-argument form, which every database has, so
  // the ETH faucet does not wait on the asset migration. tUSD names its asset.
  const { data: reserved, error: reserveErr } = await supabase.rpc('try_faucet_claim', {
    p_account_id: accountId,
    p_to: to,
    p_amount_wei: drop.units.toString(),
    p_cooldown_hours: drop.cooldownHours,
    ...(drop.asset === 'ETH' ? {} : { p_asset: drop.asset }),
  });
  if (reserveErr) throw new Error(reserveErr.message);
  const row = (Array.isArray(reserved) ? reserved[0] : reserved) as { claim_id: string | null; next_claim_at: string } | null;
  if (!row) throw new Error('try_faucet_claim returned nothing');
  if (!row.claim_id) throw new ClientError(FAUCET_COOLDOWN);
  const claimId = row.claim_id;
  const nextClaimAt = new Date(row.next_claim_at).toISOString();

  const holder = randomUUID();
  let locked = false;
  /** Set once the claim has an outcome recorded: failed, or a transaction that exists. */
  let settled = false;
  const fail = async (error: string) => {
    settled = true;
    await markClaim(supabase, claimId, { status: 'failed', error });
  };
  try {
    const sender = deps.sender ?? getFaucetSender();
    locked = await takeSignerLock(supabase, holder);
    if (!locked) {
      await fail('signer busy');
      throw new ClientError(FAUCET_BUSY);
    }

    // ETH must cover the drop and the gas; a token drop still pays its gas in ETH.
    const balance = await sender.balance();
    const ethNeeded = drop.token ? GAS_RESERVE_WEI : drop.units + GAS_RESERVE_WEI;
    if (balance < ethNeeded) {
      console.warn(`[faucet] dispenser balance ${ethers.formatEther(balance)} ETH is below one claim; refill it`);
      await fail('dispenser empty');
      throw new ClientError(FAUCET_EMPTY);
    }
    if (drop.token) {
      const held = await sender.tokenBalance(drop.token);
      if (held < drop.units) {
        console.warn(`[faucet] dispenser holds less than one ${drop.unit} claim; refill it`);
        await fail('dispenser empty');
        throw new ClientError(FAUCET_EMPTY);
      }
    }

    let sent;
    try {
      sent = drop.token ? await sender.sendToken(drop.token, to, drop.units) : await sender.send(to, drop.units);
    } catch (err) {
      await fail(shortError(err));
      console.error(`[faucet] send failed for claim ${claimId}: ${shortError(err)}`);
      throw new ClientError(sendFailed);
    }
    settled = true;
    await markClaim(supabase, claimId, { status: 'sent', tx_hash: sent.hash, sent_at: new Date().toISOString() });

    let outcome: 'confirmed' | 'reverted' | 'timeout';
    try {
      outcome = await sent.wait(CONFIRM_TIMEOUT_MS);
    } catch (err) {
      // The transaction exists; not knowing its fate is treated like a timeout.
      console.error(`[faucet] could not confirm claim ${claimId}: ${shortError(err)}`);
      outcome = 'timeout';
    }
    if (outcome === 'reverted') {
      await markClaim(supabase, claimId, { status: 'failed', error: 'reverted' });
      throw new ClientError(sendFailed);
    }
    if (outcome === 'confirmed') await markClaim(supabase, claimId, { status: 'confirmed' });

    return {
      asset: drop.asset,
      unit: drop.unit,
      amount: drop.amount,
      amountEth: drop.amount,
      status: outcome === 'confirmed' ? 'confirmed' : 'sent',
      txHash: sent.hash,
      txUrl: txUrl(sent.hash) as string,
      nextClaimAt,
    };
  } catch (err) {
    // Anything that failed before a transaction existed frees the claim.
    if (!settled) await fail(shortError(err));
    throw err;
  } finally {
    if (locked) {
      const { error } = await supabase.rpc('release_faucet_signer_lock', { p_holder: holder });
      if (error) console.error(`[faucet] could not release the signer lock: ${error.message}`);
    }
  }
}
