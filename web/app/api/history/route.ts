import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { apiErrorBody } from '../../../lib/apiError';
import { listPendingClaimSummaries } from '../../../lib/pendingClaims';
// Shared with chat history — platform claims must show GitHub pay / Phone / X pay
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  formatClaimHistoryLabel,
  claimHistoryCounterparty,
} = require('../../../../lib/claimHistoryLabel');
// Same query the bot runs, for the same reason the label formatter is shared:
// two implementations of "what happened on this account" disagreed.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadSettledHistory } = require('../../../../lib/history');

const ROUTE = 'GET /api/history';

/** One row from lib/history.js, before the site decides how to draw it. */
type HistoryEntry = {
  source: 'transfer' | 'claim';
  row: Record<string, unknown>;
  /**
   * Whether this payment came in, decided by lib/history.js from the wallet it
   * was sent to. Not on the row: every transfers row is written by the sender,
   * so `direction` there is always 'out' no matter who is reading it.
   */
  received?: boolean;
  /** Who paid, for a received row. Resolved from the sender's account. */
  fromLabel?: string | null;
  createdAt: string;
};

export type ActivityItem = {
  id: string;
  type: 'transfer' | 'receive' | 'claim' | 'swap' | 'withdraw';
  direction: 'in' | 'out';
  amount: string | number;
  asset: string;
  amountSecondary?: string | null;
  assetSecondary?: string | null;
  counterparty?: string | null;
  status: string;
  txHash?: string | null;
  createdAt: string;
  /** What the payment was for, as the sender typed it. Null when unsaid. */
  note?: string | null;
  label: string;
};

function shortAddr(addr: string) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function mapTransferRow(
  row: Record<string, unknown>,
  received = false,
  fromLabel: string | null = null
): ActivityItem {
  const kind = String(row.kind || 'transfer').toLowerCase();
  // lib/history.js decides this once, from the wallet the payment was sent to.
  // Reading row.direction here would call every payment "sent", because the row
  // belongs to whoever made it.
  const direction = received ? 'in' : 'out';
  const asset = String(row.asset || 'ETH').toUpperCase();
  const amount = row.amount_eth as string | number;
  const to = row.to_address ? String(row.to_address) : '';
  const labelExtra = row.counterparty_label ? String(row.counterparty_label) : null;

  let type: ActivityItem['type'] = 'transfer';
  if (kind === 'swap') type = 'swap';
  else if (kind === 'withdraw' || kind === 'withdraw_token') type = 'withdraw';
  else if (direction === 'in') type = 'receive';
  else type = 'transfer';

  let label = '';
  if (type === 'swap') {
    const outAmt = row.amount_secondary ? String(row.amount_secondary) : null;
    const outAsset = row.asset_secondary ? String(row.asset_secondary) : null;
    label = outAmt && outAsset ? `${amount} ${asset} → ${outAmt} ${outAsset}` : `Swap ${amount} ${asset}`;
  } else if (type === 'receive') {
    // Not labelExtra: on a received row that names the reader, not the payer.
    // And never row.phone, which is the sender's own number.
    label = fromLabel
      ? `Received ${amount} ${asset} from ${fromLabel}`
      : `Received ${amount} ${asset}`;
  } else if (kind === 'nft_market') {
    // Written by POST /api/market/[action], e.g. "Buy Giwaforge #12 for 0.05 ETH".
    label = labelExtra || 'NFT marketplace';
  } else {
    const dest = labelExtra || (to ? shortAddr(to) : '—');
    label = `Sent ${amount} ${asset} → ${dest}`;
  }

  return {
    id: String(row.id),
    type,
    direction,
    amount,
    asset,
    amountSecondary: row.amount_secondary ? String(row.amount_secondary) : null,
    assetSecondary: row.asset_secondary ? String(row.asset_secondary) : null,
    counterparty: labelExtra || to || null,
    status: String(row.status || 'unknown'),
    txHash: row.tx_hash ? String(row.tx_hash) : null,
    createdAt: String(row.created_at),
    note: row.note ? String(row.note) : null,
    label,
  };
}

function mapClaimRow(row: Record<string, unknown>, accountId: string): ActivityItem {
  const status = String(row.status || 'pending');
  const amount = row.amount_eth as string | number;
  const isSender = row.from_account_id === accountId;
  let type: ActivityItem['type'] = 'claim';
  let direction: 'in' | 'out' = 'out';
  let label = '';
  let txHash: string | null = null;

  if (isSender) {
    direction = 'out';
    if (status === 'cancelled') {
      label = formatClaimHistoryLabel(row, { role: 'sender', status: 'cancelled' });
      txHash = row.refund_tx_hash ? String(row.refund_tx_hash) : null;
      type = 'receive';
      direction = 'in';
    } else if (status === 'claimed') {
      label = formatClaimHistoryLabel(row, { role: 'sender', status: 'claimed' });
      // Prefer payout hash so "View tx" is the claim receive leg, not only the hold
      txHash = row.claim_tx_hash
        ? String(row.claim_tx_hash)
        : row.hold_tx_hash
          ? String(row.hold_tx_hash)
          : null;
      type = 'claim';
    } else {
      label = formatClaimHistoryLabel(row, { role: 'sender', status });
      txHash = row.hold_tx_hash ? String(row.hold_tx_hash) : null;
      type = 'claim';
    }
  } else {
    // Recipient view — claimed payout must show with claim_tx_hash
    direction = 'in';
    type = status === 'claimed' ? 'receive' : 'claim';
    label = formatClaimHistoryLabel(row, { role: 'receiver', status });
    txHash = row.claim_tx_hash
      ? String(row.claim_tx_hash)
      : status !== 'claimed' && row.hold_tx_hash
        ? String(row.hold_tx_hash)
        : null;
  }

  return {
    id: `claim_${row.id}`,
    type,
    direction,
    amount,
    asset: String(row.asset || 'ETH').toUpperCase(),
    counterparty: claimHistoryCounterparty(row),
    status,
    txHash,
    createdAt: String(row.claimed_at || row.created_at),
    label,
  };
}

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const supabase = getSupabase();

    // Row selection, ordering and limits all live in lib/history.js. What stays
    // here is how the site renders them, which is not the same job as the chat
    // line and should not be forced into the same shape.
    // The wallet is the only way to find money somebody else sent: transfers
    // are written by the sender and keyed to the sender.
    const { data: me } = await supabase
      .from('accounts')
      .select('agent_wallet_address')
      .eq('id', accountId)
      .maybeSingle();
    const settled = await loadSettledHistory(supabase, accountId, {
      walletAddress: me?.agent_wallet_address || null,
    });

    const items: ActivityItem[] = settled.items.map((entry: HistoryEntry) =>
      entry.source === 'claim'
        ? mapClaimRow(entry.row, accountId)
        : mapTransferRow(entry.row, Boolean(entry.received), entry.fromLabel ?? null)
    );

    const transferRows = settled.items
      .filter((e: HistoryEntry) => e.source === 'transfer')
      .map((e: HistoryEntry) => e.row);

    // Money already sent to this user and not yet collected. Kept out of the
    // settled list on purpose: it is not something that happened, it is
    // something still to do.
    let waiting: Awaited<ReturnType<typeof listPendingClaimSummaries>> = [];
    try {
      waiting = await listPendingClaimSummaries(accountId);
    } catch {
      // Settled activity is still worth returning without it.
    }

    // Backward-compatible transfers key for older clients
    return NextResponse.json({
      activity: items,
      waiting,
      transfers: transferRows.slice(0, 30),
      limit: 30,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
