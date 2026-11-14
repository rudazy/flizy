/**
 * Gas paid for wallets through their EntryPoint deposit.
 *
 * Mirror of lib/gasTopup.js (web/ cannot import root lib/), which documents the
 * rules: the GAS_TOPUP_ENABLED switch and its own key (never PRIVATE_KEY), one
 * top-up in flight per key through the relayer lease, the per-wallet daily cap
 * at FEE_ETH_USD_RATE, the gas_topups row written before each top-up, and that
 * a top-up which cannot be made never fails the payment. test/gasTopup.test.js
 * runs both.
 *
 * Testnet stopgap: a deposit can be withdrawn by the wallet's owner, so this is
 * replaced with a paymaster before ownership moves to users.
 */

import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULTS as FEE_DEFAULTS, parseUsdMicro } from './fees.ts';
import { withRelayerLock } from './relayerLock.ts';
import { classifyBroadcastError } from './gatorExecute.ts';

const TABLE = 'gas_topups';
const DAY_MS = 24 * 3600 * 1000;
export const TOPUP_MARGIN_BPS = 12_500n;
const DEPOSIT_GAS_LIMIT = 80_000n;
const RECEIPT_TIMEOUT_MS = 60_000;
const DEFAULT_WALLET_DAILY_CAP_USD = '0.5';

const EP_IFACE = new ethers.Interface(['function depositTo(address account) payable', 'function balanceOf(address account) view returns (uint256)']);

type Env = Record<string, string | undefined>;
type Log = { warn: (line: string) => void; info: (line: string) => void };

export type TopupConfig = Readonly<{ enabled: boolean; address: string | null; walletDailyCap: bigint; ethUsd: bigint }>;

/** Error text for a log line: URLs (which can carry an RPC key) dropped, capped. */
function short(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/https?:\/\/\S+/g, '[url]').slice(0, 160);
}

/** The top-up settings. On without a key, or a malformed cap or key, throws. */
export function topupConfig(env: Env = process.env): TopupConfig {
  const enabled = String(env.GAS_TOPUP_ENABLED || '').trim().toLowerCase() === 'true';
  const rawKey = String(env.GAS_TOPUP_PRIVATE_KEY || '').trim();
  let address: string | null = null;
  if (rawKey) {
    try {
      address = new ethers.Wallet(rawKey).address;
    } catch {
      throw new Error('GAS_TOPUP_PRIVATE_KEY is not a private key');
    }
    if (rawKey.toLowerCase() === String(env.PRIVATE_KEY || '').trim().toLowerCase()) {
      throw new Error('GAS_TOPUP_PRIVATE_KEY must not be PRIVATE_KEY');
    }
  }
  if (enabled && !address) throw new Error('GAS_TOPUP_ENABLED needs GAS_TOPUP_PRIVATE_KEY');
  const capRaw = String(env.GAS_TOPUP_WALLET_DAILY_CAP_USD || '').trim() || DEFAULT_WALLET_DAILY_CAP_USD;
  const rateRaw = String(env.FEE_ETH_USD_RATE || '').trim() || FEE_DEFAULTS.FEE_ETH_USD_RATE;
  const ethUsd = parseUsdMicro(rateRaw, 'FEE_ETH_USD_RATE');
  if (ethUsd === 0n) throw new Error('FEE_ETH_USD_RATE must be above zero');
  return Object.freeze({ enabled, address, walletDailyCap: parseUsdMicro(capRaw, 'GAS_TOPUP_WALLET_DAILY_CAP_USD'), ethUsd });
}

export function topupAmountWei(shortfallWei: bigint): bigint {
  return (BigInt(shortfallWei) * TOPUP_MARGIN_BPS + 9_999n) / 10_000n;
}

export function weiToUsdMicro(wei: bigint, ethUsd: bigint): bigint {
  return (BigInt(wei) * BigInt(ethUsd) + 10n ** 18n - 1n) / 10n ** 18n;
}

/** micro-USD topped up for this wallet in the last 24 hours, pending or sent. Throws when it cannot be read. */
export async function toppedUpToday(supabase: SupabaseClient, wallet: string, now: number = Date.now()): Promise<bigint> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('usd_micro')
    .eq('wallet', String(wallet).toLowerCase())
    .in('status', ['pending', 'sent'])
    .gte('created_at', new Date(now - DAY_MS).toISOString());
  if (error) throw new Error(error.message);
  return ((data || []) as Array<{ usd_micro: string | number }>).reduce((sum, r) => sum + BigInt(r.usd_micro), 0n);
}

/** Whether a top-up would cover this shortfall right now. Reads only; never throws. */
export async function topupWouldCover(p: { supabase: SupabaseClient; wallet: string; shortfallWei: bigint; env?: Env }): Promise<boolean> {
  try {
    const cfg = topupConfig(p.env ?? process.env);
    if (!cfg.enabled || BigInt(p.shortfallWei) <= 0n) return false;
    const usd = weiToUsdMicro(topupAmountWei(p.shortfallWei), cfg.ethUsd);
    return (await toppedUpToday(p.supabase, p.wallet)) + usd <= cfg.walletDailyCap;
  } catch {
    return false;
  }
}

export type TopupResult = { ok: true; amountWei: bigint; txHash: string; blockNumber: number } | { ok: false; reason: string };

/** Pay EntryPoint.depositTo(wallet) for a shortfall, within the cap. ok only once the deposit is mined. Never throws. */
export async function topUpGasDeposit(p: {
  supabase: SupabaseClient;
  provider: ethers.JsonRpcProvider;
  entryPoint: string;
  wallet: string;
  accountId?: string | null;
  shortfallWei: bigint;
  env?: Env;
  log?: Log;
  /** Tests hand in a recording signer; live, it is always the top-up key. */
  signer?: Pick<ethers.Wallet, 'address' | 'populateTransaction' | 'signTransaction'>;
}): Promise<TopupResult> {
  const env = p.env ?? process.env;
  const log = p.log ?? console;
  const { supabase, provider } = p;
  let cfg: TopupConfig;
  try {
    cfg = topupConfig(env);
  } catch (err) {
    log.warn(`[gas-topup] settings: ${short(err)}`);
    return { ok: false, reason: 'settings' };
  }
  if (!cfg.enabled) return { ok: false, reason: 'off' };
  const shortfall = BigInt(p.shortfallWei);
  if (shortfall <= 0n) return { ok: false, reason: 'none needed' };
  const amountWei = topupAmountWei(shortfall);
  const usdMicro = weiToUsdMicro(amountWei, cfg.ethUsd);
  const walletLower = ethers.getAddress(p.wallet).toLowerCase();
  const fail = async (rowId: string | null, reason: string): Promise<TopupResult> => {
    log.warn(`[gas-topup] not topped up: ${reason}`);
    if (rowId) {
      const { error } = await supabase.from(TABLE).update({ status: 'failed', reason: reason.slice(0, 200) }).eq('id', rowId);
      if (error) log.warn(`[gas-topup] could not mark the row failed: ${error.message}`);
    }
    return { ok: false, reason };
  };

  let spent: bigint;
  try {
    spent = await toppedUpToday(supabase, walletLower);
  } catch (err) {
    return fail(null, `could not read today's top-ups (${short(err)})`);
  }
  if (spent + usdMicro > cfg.walletDailyCap) return fail(null, 'daily cap reached');

  const key = p.signer ?? new ethers.Wallet(String(env.GAS_TOPUP_PRIVATE_KEY).trim(), provider);
  const data = EP_IFACE.encodeFunctionData('depositTo', [ethers.getAddress(p.wallet)]);
  try {
    const fee = await provider.getFeeData();
    const maxFee = fee.maxFeePerGas || fee.gasPrice || 0n;
    if ((await provider.getBalance(key.address)) < amountWei + DEPOSIT_GAS_LIMIT * maxFee) return fail(null, 'the top-up key is out of ETH');
  } catch (err) {
    return fail(null, `could not read the top-up key (${short(err)})`);
  }

  const { data: row, error: insErr } = await supabase
    .from(TABLE)
    .insert({ wallet: walletLower, account_id: p.accountId ?? null, amount_wei: amountWei.toString(), usd_micro: usdMicro.toString(), status: 'pending' })
    .select('id')
    .maybeSingle();
  if (insErr || !row || !row.id) return fail(null, `could not record the top-up (${insErr ? insErr.message : 'no row'})`);
  const rowId = String(row.id);

  let sent: { hash: string; kind: 'accepted' | 'rejected' | 'unknown'; err?: unknown };
  try {
    sent = await withRelayerLock({ supabase, relayer: key.address }, async () => {
      const populated = await key.populateTransaction({ to: p.entryPoint, data, value: amountWei, gasLimit: DEPOSIT_GAS_LIMIT });
      const signed = await key.signTransaction(populated);
      const hash = ethers.keccak256(signed);
      try {
        await provider.broadcastTransaction(signed);
        return { hash, kind: 'accepted' as const };
      } catch (err) {
        return { hash, kind: classifyBroadcastError(err), err };
      }
    });
  } catch (err) {
    return fail(rowId, `not sent (${short(err)})`);
  }
  if (sent.kind === 'rejected') return fail(rowId, `refused by the node (${short(sent.err)})`);
  const txHash = sent.hash;
  // Accepted, or no answer: it may land, so it is 'sent' and counts against the cap either way.
  const { error: sentErr } = await supabase.from(TABLE).update({ status: 'sent', tx_hash: txHash }).eq('id', rowId);
  if (sentErr) log.warn(`[gas-topup] could not record the hash: ${sentErr.message}`);
  if (sent.kind === 'unknown') return { ok: false, reason: 'no answer from the node' };

  let receipt: ethers.TransactionReceipt | null = null;
  try {
    receipt = await provider.waitForTransaction(txHash, 1, RECEIPT_TIMEOUT_MS);
  } catch {
    receipt = null;
  }
  if (!receipt) return { ok: false, reason: 'not mined yet' };
  if (receipt.status !== 1) return fail(rowId, 'the deposit reverted');
  log.info(`[gas-topup] deposit for a wallet, ${ethers.formatEther(amountWei)} ETH`);
  return { ok: true, amountWei, txHash, blockNumber: receipt.blockNumber };
}
