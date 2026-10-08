import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import { getSupabase } from './supabase.ts';
import { ClientError } from './apiError.ts';
import { getWebChain } from './webChain.ts';
import { closureOf, isMissingClosureColumn } from './accountClosure.ts';

/**
 * One-tap faucet: GIWA Sepolia test ETH from a Flizy-run dispenser wallet to
 * the signed-in account's own Flizy wallet.
 *
 * The rules live here and in supabase/migrations/20261010120000_faucet_claims.sql,
 * never in the browser:
 *   - the amount and the cooldown are constants on this side, not inputs;
 *   - the destination is the account's stored wallet, never an address from
 *     the request;
 *   - try_faucet_claim reserves the claim under a per-account lock, so a
 *     double click or two tabs produce one claim;
 *   - one send at a time leaves the dispenser wallet (faucet_signer_lock), so
 *     two people claiming at once cannot race on its nonce.
 *
 * The dispenser key is FAUCET_PRIVATE_KEY and nothing else. It never falls back
 * to the ops key, so a faucet bug cannot spend the gas the rest of Flizy runs
 * on, and a testnet guard refuses to run it on any other chain.
 */

export type Db = ReturnType<typeof getSupabase>;

export const FAUCET_AMOUNT_ETH = '0.02';
export const FAUCET_COOLDOWN_HOURS = 72;
/** GIWA Sepolia. The faucet hands out test ETH and runs nowhere else. */
export const FAUCET_CHAIN_ID = 91342;

const AMOUNT_WEI = ethers.parseEther(FAUCET_AMOUNT_ETH);
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
export const FAUCET_COOLDOWN = 'You have already claimed. Come back when the timer ends.';

/** What sending needs from the chain. Injectable, so the rules are testable without a network. */
export type FaucetSender = {
  balance(): Promise<bigint>;
  send(to: string, valueWei: bigint): Promise<{
    hash: string;
    /** confirmed, reverted, or timeout when no receipt arrived in time. */
    wait(timeoutMs: number): Promise<'confirmed' | 'reverted' | 'timeout'>;
  }>;
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

  return {
    balance: () => provider.getBalance(wallet.address),
    async send(to, valueWei) {
      // The RPC is asked which chain it serves before anything is signed; the
      // static network above only stops ethers asking on every call.
      const network = await provider.send('eth_chainId', []);
      if (Number(network) !== FAUCET_CHAIN_ID) {
        throw new Error(`The RPC serves chain ${Number(network)}, not GIWA Sepolia.`);
      }
      const tx = await wallet.sendTransaction({ to, value: valueWei });
      return {
        hash: tx.hash,
        async wait(timeoutMs) {
          try {
            const receipt = await provider.waitForTransaction(tx.hash, 1, timeoutMs);
            if (!receipt) return 'timeout';
            return receipt.status === 1 ? 'confirmed' : 'reverted';
          } catch (err) {
            if (ethers.isError(err, 'TIMEOUT')) return 'timeout';
            throw err;
          }
        },
      };
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

/** The claim that holds the cooldown: the newest one that did not fail and was not abandoned. */
async function lastCountingClaim(accountId: string, supabase: Db, now: number): Promise<ClaimRow | null> {
  const { data, error } = await supabase
    .from('faucet_claims')
    .select('id, status, tx_hash, created_at, sent_at')
    .eq('account_id', accountId)
    .gte('created_at', new Date(now - FAUCET_COOLDOWN_HOURS * 3600e3).toISOString())
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  for (const row of (data || []) as ClaimRow[]) {
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

export async function faucetStatus(accountId: string, client?: Db, now = Date.now()): Promise<FaucetStatus> {
  const supabase = client ?? getSupabase();
  const account = await loadAccount(accountId, supabase);
  const blocked = ineligibility(account);
  const last = account ? await lastCountingClaim(accountId, supabase, now) : null;
  const ready = faucetConfigured();
  return {
    amountEth: FAUCET_AMOUNT_ETH,
    cooldownHours: FAUCET_COOLDOWN_HOURS,
    ready,
    eligible: ready && !blocked,
    reason: !ready ? FAUCET_NOT_SET_UP : blocked?.reason ?? null,
    fix: blocked?.fix ?? null,
    username: account?.username ?? null,
    nextClaimAt: last ? new Date(new Date(last.created_at).getTime() + FAUCET_COOLDOWN_HOURS * 3600e3).toISOString() : null,
    lastClaim: last ? { status: last.status, txUrl: txUrl(last.tx_hash), at: last.created_at } : null,
  };
}

export type FaucetReceipt = {
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
 * Claim once. Sends exactly FAUCET_AMOUNT_ETH to the account's stored wallet.
 *
 * Anything that fails before a transaction exists marks the claim failed, which
 * frees it to be tried again. A transaction that was sent but not confirmed in
 * time keeps the cooldown: it may still land, and paying twice is the worse
 * mistake.
 */
export async function claimFaucet(
  accountId: string,
  deps: { client?: Db; sender?: FaucetSender } = {}
): Promise<FaucetReceipt> {
  const supabase = deps.client ?? getSupabase();
  if (!deps.sender && !faucetConfigured()) throw new ClientError(FAUCET_NOT_SET_UP);

  const account = await loadAccount(accountId, supabase);
  const blocked = ineligibility(account);
  if (blocked || !account) throw new ClientError(blocked?.reason || 'This account cannot claim.');
  const to = ethers.getAddress(String(account.agent_wallet_address));

  const { data: reserved, error: reserveErr } = await supabase.rpc('try_faucet_claim', {
    p_account_id: accountId,
    p_to: to,
    p_amount_wei: AMOUNT_WEI.toString(),
    p_cooldown_hours: FAUCET_COOLDOWN_HOURS,
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

    const balance = await sender.balance();
    if (balance < AMOUNT_WEI + GAS_RESERVE_WEI) {
      console.warn(`[faucet] dispenser balance ${ethers.formatEther(balance)} ETH is below one claim; refill it`);
      await fail('dispenser empty');
      throw new ClientError(FAUCET_EMPTY);
    }

    let sent;
    try {
      sent = await sender.send(to, AMOUNT_WEI);
    } catch (err) {
      await fail(shortError(err));
      console.error(`[faucet] send failed for claim ${claimId}: ${shortError(err)}`);
      throw new ClientError(FAUCET_SEND_FAILED);
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
      throw new ClientError(FAUCET_SEND_FAILED);
    }
    if (outcome === 'confirmed') await markClaim(supabase, claimId, { status: 'confirmed' });

    return {
      amountEth: FAUCET_AMOUNT_ETH,
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
