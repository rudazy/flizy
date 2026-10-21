import { ethers } from 'ethers';
import { getSupabase } from './supabase.ts';
import { ClientError } from './apiError.ts';
import { PAYMENT_RECEIVER } from './paymentReceiver.ts';
import { listedBySymbol } from './listedTokens.ts';
import { getDexAddresses } from './dexServer';
import { cleanPayNote } from './payLink.ts';

/**
 * Paying a Flizy account from a wallet outside Flizy.
 *
 * The browser wallet calls FlizyPaymentReceiver (contracts/src/pay), which
 * forwards the money to the payee in the same transaction and emits
 * PaymentReceived. Nothing the browser says is believed: the confirm route
 * hands over a transaction hash, and this module reads that transaction's
 * receipt from the chain and records only events that
 *   - were emitted by the receiver at PAYMENT_RECEIVER,
 *   - paid the payee's own Flizy wallet,
 *   - in ETH or a token on the pay list, at its listed contract,
 *   - in a transaction that succeeded.
 * Each event is recorded once (external_payments is unique on tx and log
 * index), so confirming twice, or from two tabs, records one payment.
 */

export type Db = ReturnType<typeof getSupabase>;

export const RECEIVER_ABI = [
  'event PaymentReceived(bytes32 indexed invoiceId, address indexed payer, address indexed payee, address token, uint256 amount)',
  'function payNative(bytes32 invoiceId, address payee) payable',
  'function payToken(bytes32 invoiceId, address token, address payee, uint256 amount)',
] as const;

const iface = new ethers.Interface(RECEIVER_ABI);
const PAYMENT_TOPIC = iface.getEvent('PaymentReceived')!.topicHash;

export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
export const EXTERNAL_TX_FAILED = 'That transaction did not go through, so nothing was paid.';
export const EXTERNAL_NOTHING_FOUND = 'That transaction did not pay this account through Flizy.';

/** Which asset a token address is, among those the pay page sends. Null for anything else. */
export function payAssetForToken(token: string): { asset: 'ETH' | 'FLZ' | 'TUSD'; decimals: number } | null {
  const lower = token.toLowerCase();
  if (lower === ethers.ZeroAddress) return { asset: 'ETH', decimals: 18 };
  if (lower === getDexAddresses().flz.toLowerCase()) return { asset: 'FLZ', decimals: 18 };
  const tusd = listedBySymbol('TUSD');
  if (tusd && lower === tusd.address.toLowerCase()) return { asset: 'TUSD', decimals: tusd.decimals };
  return null;
}

export type ExternalPayment = {
  logIndex: number;
  invoiceId: string;
  payer: string;
  payee: string;
  token: string;
  asset: 'ETH' | 'FLZ' | 'TUSD';
  units: bigint;
  amount: string;
};

type ReceiptLike = {
  status: number | null;
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string; index: number }>;
};

/**
 * The payments in one receipt that count for this payee. Pure, so the rules
 * are testable without a chain: a log from another address, to another payee,
 * or in a token off the list, is ignored, however it was shaped.
 */
export function paymentsInReceipt(receipt: ReceiptLike, payeeAddress: string, receiver: string = PAYMENT_RECEIVER): ExternalPayment[] {
  if (receipt.status !== 1) throw new ClientError(EXTERNAL_TX_FAILED);
  const payee = payeeAddress.toLowerCase();
  const found: ExternalPayment[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== receiver.toLowerCase()) continue;
    if (log.topics[0] !== PAYMENT_TOPIC) continue;
    let parsed: ethers.LogDescription | null;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    const [invoiceId, payer, to, token, units] = parsed.args as unknown as [string, string, string, string, bigint];
    if (to.toLowerCase() !== payee || units <= 0n) continue;
    const listed = payAssetForToken(token);
    if (!listed) continue;
    found.push({
      logIndex: log.index,
      invoiceId: invoiceId.toLowerCase(),
      payer: payer.toLowerCase(),
      payee,
      token: token.toLowerCase(),
      asset: listed.asset,
      units,
      amount: ethers.formatUnits(units, listed.decimals),
    });
  }
  return found;
}

/** The pay route's own copy of how many confirm calls one address may make in an hour. */
export const EXTERNAL_CONFIRMS_PER_HOUR = 30;

/** Count this call and say whether it is within the hour's cap. A counter that cannot be read refuses. */
export async function takeExternalAttempt(supabase: Db, ipKey: string, now = Date.now()): Promise<boolean> {
  const since = new Date(now - 3600e3).toISOString();
  const { data, error } = await supabase
    .from('external_pay_attempts')
    .select('id')
    .eq('ip_key', ipKey)
    .gte('created_at', since)
    .limit(EXTERNAL_CONFIRMS_PER_HOUR + 1);
  if (error) return false;
  if ((data || []).length >= EXTERNAL_CONFIRMS_PER_HOUR) return false;
  const { error: insErr } = await supabase.from('external_pay_attempts').insert({ ip_key: ipKey });
  return !insErr;
}

/**
 * Record the payments a confirmed transaction made to this account. Returns
 * the ones recorded by this call; a payment already on record is skipped, so
 * the caller notifies the payee exactly once.
 */
export async function recordExternalPayments(
  supabase: Db,
  p: { txHash: string; payeeAccountId: string; payments: ExternalPayment[]; note?: unknown }
): Promise<ExternalPayment[]> {
  const note = cleanPayNote(p.note);
  const recorded: ExternalPayment[] = [];
  for (const pay of p.payments) {
    const { data: inserted, error } = await supabase
      .from('external_payments')
      .upsert(
        {
          tx_hash: p.txHash.toLowerCase(),
          log_index: pay.logIndex,
          invoice_id: pay.invoiceId,
          payer_address: pay.payer,
          payee_account_id: p.payeeAccountId,
          payee_address: pay.payee,
          asset: pay.asset,
          token_address: pay.asset === 'ETH' ? null : pay.token,
          amount_units: pay.units.toString(),
          amount: pay.amount,
          note,
        },
        { onConflict: 'tx_hash,log_index', ignoreDuplicates: true }
      )
      .select('id');
    if (error) throw new Error(error.message);
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!row?.id) continue;

    // The payee's history reads transfers by the wallet paid. The payer has no
    // account, so the row has none either, and its channel key says where it
    // came from.
    const { data: transfer, error: tErr } = await supabase
      .from('transfers')
      .insert({
        account_id: null,
        phone: 'external',
        to_address: ethers.getAddress(pay.payee),
        amount_eth: pay.amount,
        status: 'confirmed',
        tx_hash: p.txHash.toLowerCase(),
        kind: 'transfer',
        asset: pay.asset,
        token_address: pay.asset === 'ETH' ? null : ethers.getAddress(pay.token),
        counterparty_label: `${pay.payer.slice(0, 6)}…${pay.payer.slice(-4)}`,
        direction: 'out',
        note,
      })
      .select('id')
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    if (transfer?.id) {
      await supabase.from('external_payments').update({ transfer_id: transfer.id }).eq('id', row.id);
    }
    recorded.push(pay);
  }
  return recorded;
}
