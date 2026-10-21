import { ethers } from 'ethers';
import { getSupabase } from './supabase.ts';
import { assetSymbol } from './historyRow.ts';
import { listedByAddress, listedBySymbol } from './listedTokens.ts';
import { displaySafeLabel } from './sanitize.ts';
import { buildPayLink } from './payLink.ts';
import type { PayAsset } from './payAsset.ts';

/**
 * Getting paid, seen from the payee's side: every confirmed payment into this
 * account's wallet over a window, totals per asset, and a CSV of the same rows.
 *
 * Read from transfers by the wallet paid, the same way History finds money
 * somebody else sent (lib/history.js). One payment, one row, whichever end
 * reads it. Swaps, claims and marketplace rows are other kinds and never count.
 */

export type Db = ReturnType<typeof getSupabase>;

/** The windows the page offers. Anything else is refused rather than guessed. */
export const RECEIVED_WINDOWS = [30, 90, 365] as const;
export type ReceivedWindow = (typeof RECEIVED_WINDOWS)[number];

/** The most rows one read returns. A CSV past this says so in its last line. */
export const RECEIVED_MAX = 1000;

export type ReceivedPayment = {
  id: string;
  at: string;
  amount: string;
  /** How the asset prints: ETH, FLZ, tUSD, or a shortened address. */
  unit: string;
  /** The pay-list asset, when it is one, so a refund can be offered. */
  asset: PayAsset | null;
  from: string;
  note: string | null;
  txHash: string | null;
  /** Where a refund goes: the payer's pay page, when the payer is a Flizy account with one. */
  refundRef: string | null;
};

type Row = {
  id: string;
  account_id: string | null;
  amount_eth: string | number;
  asset: string | null;
  token_address: string | null;
  tx_hash: string | null;
  created_at: string;
  note: string | null;
  phone: string | null;
  counterparty_label: string | null;
};

function payAssetOf(row: Row): PayAsset | null {
  const listed = row.token_address ? listedByAddress(row.token_address) : null;
  if (listed?.sendable) return listed.symbol as PayAsset;
  const s = String(row.asset || 'ETH').toUpperCase();
  if (s === 'ETH' && !row.token_address) return 'ETH';
  if (s === 'FLZ') return 'FLZ';
  if (s === 'TUSD' && listedBySymbol('TUSD')) return 'TUSD';
  return null;
}

/** Confirmed payments into this wallet in the window, newest first, with who paid. */
export async function loadReceived(
  walletAddress: string,
  windowDays: ReceivedWindow,
  client?: Db,
  now = Date.now()
): Promise<{ payments: ReceivedPayment[]; truncated: boolean }> {
  const supabase = client ?? getSupabase();
  if (!ethers.isAddress(walletAddress)) return { payments: [], truncated: false };
  const since = new Date(now - windowDays * 86400e3).toISOString();
  const { data, error } = await supabase
    .from('transfers')
    .select('id, account_id, amount_eth, asset, token_address, tx_hash, created_at, note, phone, counterparty_label')
    .ilike('to_address', walletAddress)
    .eq('status', 'confirmed')
    .eq('kind', 'transfer')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(RECEIVED_MAX + 1);
  if (error) throw new Error(error.message);
  const rows = ((data || []) as Row[]).slice(0, RECEIVED_MAX);

  // One read for every payer on the page, as History names its senders.
  const ids = [...new Set(rows.map((r) => r.account_id).filter((v): v is string => Boolean(v)))];
  const payers = new Map<string, { username: string | null; pay_code: string | null }>();
  if (ids.length) {
    const { data: accts } = await supabase.from('accounts').select('id, username').in('id', ids);
    for (const a of (accts || []) as Array<{ id: string; username: string | null }>) {
      payers.set(String(a.id), { username: a.username, pay_code: null });
    }
    // A payer with no username can still be refunded through their Flizy number.
    const { data: codes } = await supabase.from('pay_codes').select('account_id, code').in('account_id', ids);
    for (const c of (codes || []) as Array<{ account_id: string; code: string }>) {
      const p = payers.get(String(c.account_id));
      if (p) p.pay_code = c.code;
    }
  }

  const payments = rows.map((r) => {
    const payer = r.account_id ? payers.get(String(r.account_id)) : undefined;
    const from = payer?.username
      ? `@${payer.username}`
      : r.phone === 'external'
        ? `Outside wallet ${displaySafeLabel(r.counterparty_label || '', 20)}`.trim()
        : 'A Flizy account';
    return {
      id: String(r.id),
      at: String(r.created_at),
      amount: String(r.amount_eth),
      unit: assetSymbol(r.token_address || r.asset || 'ETH'),
      asset: payAssetOf(r),
      from,
      note: r.note ? displaySafeLabel(r.note, 80) || null : null,
      txHash: r.tx_hash,
      refundRef: payer?.username || payer?.pay_code || null,
    };
  });
  return { payments, truncated: (data || []).length > RECEIVED_MAX };
}

/**
 * Totals per asset, added in each asset's smallest unit so 0.1 + 0.2 is 0.3.
 * Assets the page cannot name by decimals are left out of the totals, not
 * guessed at; their rows still list.
 */
export function totalsByAsset(payments: ReceivedPayment[]): Array<{ unit: string; total: string; count: number }> {
  const sums = new Map<string, { units: bigint; decimals: number; count: number }>();
  for (const p of payments) {
    if (!p.asset) continue;
    const decimals = p.asset === 'TUSD' ? (listedBySymbol('TUSD')?.decimals ?? 6) : 18;
    let units: bigint;
    try {
      units = ethers.parseUnits(p.amount, decimals);
    } catch {
      continue;
    }
    const cur = sums.get(p.unit) || { units: 0n, decimals, count: 0 };
    cur.units += units;
    cur.count += 1;
    sums.set(p.unit, cur);
  }
  return [...sums.entries()].map(([unit, s]) => ({ unit, total: ethers.formatUnits(s.units, s.decimals), count: s.count }));
}

/**
 * One CSV cell. Quoted always, quotes doubled, and a cell that a spreadsheet
 * would run as a formula (= + - @, tab, carriage return) is prefixed with an
 * apostrophe: the payer's name and note are other people's text, opened in
 * the payee's spreadsheet.
 */
export function csvCell(value: unknown): string {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function receivedCsv(payments: ReceivedPayment[], truncated: boolean): string {
  const lines = [['Date (UTC)', 'Amount', 'Asset', 'From', 'For', 'Transaction'].map(csvCell).join(',')];
  for (const p of payments) {
    lines.push([p.at, p.amount, p.unit, p.from, p.note || '', p.txHash || ''].map(csvCell).join(','));
  }
  if (truncated) lines.push(csvCell(`Only the newest ${RECEIVED_MAX} payments are listed. Pick a shorter window for the rest.`));
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * A refund is a payment back, made through the ordinary pay page so it takes
 * the PIN, the limits and the notices every payment takes. Offered only for a
 * payer with a Flizy pay page and an asset the page can send.
 */
export function refundLink(origin: string, p: ReceivedPayment): string | null {
  if (!p.refundRef || !p.asset) return null;
  const day = p.at.slice(0, 10);
  // A username opens /pay/{name}; a Flizy number opens /pay/c/{code}, the route
  // that resolves codes and nothing else.
  const path = /^[2-9A-HJ-NP-Z]{6}$|^[0-9]{9}$/.test(p.refundRef) ? `pay/c/${p.refundRef}` : `pay/${encodeURIComponent(p.refundRef)}`;
  return buildPayLink(`${origin}/${path}`, {
    amount: p.amount,
    asset: p.asset,
    note: `Refund of payment on ${day}`,
  });
}
