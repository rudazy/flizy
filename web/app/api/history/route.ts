import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';

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
  label: string;
};

function shortAddr(addr: string) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function mapTransferRow(row: Record<string, unknown>): ActivityItem {
  const kind = String(row.kind || 'transfer').toLowerCase();
  const direction = String(row.direction || 'out') === 'in' ? 'in' : 'out';
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
    label = `Received ${amount} ${asset}`;
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
    label,
  };
}

function mapClaimRow(row: Record<string, unknown>, accountId: string): ActivityItem {
  const status = String(row.status || 'pending');
  const amount = row.amount_eth as string | number;
  const isSender = row.from_account_id === accountId;
  const hint = row.to_wa_hint ? `+${row.to_wa_hint}` : null;
  let type: ActivityItem['type'] = 'claim';
  let direction: 'in' | 'out' = 'out';
  let label = '';
  let txHash: string | null = null;

  if (isSender) {
    direction = 'out';
    if (status === 'cancelled') {
      label = `Claim cancelled · refund ${amount} ETH`;
      txHash = row.refund_tx_hash ? String(row.refund_tx_hash) : null;
      type = 'receive';
      direction = 'in';
    } else if (status === 'claimed') {
      label = `Claim paid to ${hint || 'recipient'} · ${amount} ETH`;
      txHash = row.claim_tx_hash ? String(row.claim_tx_hash) : row.hold_tx_hash ? String(row.hold_tx_hash) : null;
      type = 'claim';
    } else {
      label = `Claim held for ${hint || 'recipient'} · ${amount} ETH`;
      txHash = row.hold_tx_hash ? String(row.hold_tx_hash) : null;
      type = 'claim';
    }
  } else {
    // Recipient view
    direction = 'in';
    type = status === 'claimed' ? 'receive' : 'claim';
    label =
      status === 'claimed'
        ? `Received claim · ${amount} ETH`
        : `Incoming claim · ${amount} ETH (${status})`;
    txHash = row.claim_tx_hash ? String(row.claim_tx_hash) : null;
  }

  return {
    id: `claim_${row.id}`,
    type,
    direction,
    amount,
    asset: 'ETH',
    counterparty: hint,
    status,
    txHash,
    createdAt: String(row.claimed_at || row.created_at),
    label,
  };
}

export async function GET() {
  try {
    const accountId = getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const supabase = getSupabase();
    const selectFull =
      'id, amount_eth, to_address, status, tx_hash, created_at, phone, chain_id, kind, asset, token_address, counterparty_label, direction, amount_secondary, asset_secondary';
    const selectCore =
      'id, amount_eth, to_address, status, tx_hash, created_at, phone, chain_id, kind';

    // Prefer account_id (swaps / site rows use this). Merge legacy phone-only rows.
    // transfers.phone holds the identity transfer key: bare id for WhatsApp,
    // namespaced (telegram:<id>) for every other channel.
    const { data: identities } = await supabase
      .from('channel_identities')
      .select('channel, external_id')
      .eq('account_id', accountId);
    const phones = (identities || [])
      .filter((i) => i.external_id)
      .map((i) => (i.channel === 'whatsapp' ? i.external_id : `${i.channel}:${i.external_id}`));

    async function loadTransfers(select: string): Promise<{
      rows: Record<string, unknown>[];
      error: { message: string } | null;
    }> {
      const byAccount = await supabase
        .from('transfers')
        .select(select)
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(40);

      if (byAccount.error) {
        return { rows: [], error: byAccount.error };
      }

      const map = new Map<string, Record<string, unknown>>();
      for (const r of (byAccount.data || []) as unknown as Record<string, unknown>[]) {
        map.set(String(r.id), r);
      }

      if (phones.length > 0) {
        // Query each phone separately — avoids fragile .in() with LID special chars
        for (const phone of phones.slice(0, 8)) {
          const byPhone = await supabase
            .from('transfers')
            .select(select)
            .eq('phone', phone)
            .order('created_at', { ascending: false })
            .limit(20);
          if (byPhone.error) continue;
          for (const r of (byPhone.data || []) as unknown as Record<string, unknown>[]) {
            map.set(String(r.id), r);
          }
        }
      }

      const rows = Array.from(map.values()).sort(
        (a, b) =>
          new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime()
      );
      return { rows: rows.slice(0, 40), error: null };
    }

    let loaded = await loadTransfers(selectFull);
    if (loaded.error) {
      loaded = await loadTransfers(selectCore);
    }
    const transferRows = loaded.rows;

    const { data: claimsOut } = await supabase
      .from('claims')
      .select(
        'id, from_account_id, to_account_id, to_wa_hint, amount_eth, status, hold_tx_hash, refund_tx_hash, claim_tx_hash, created_at, claimed_at'
      )
      .eq('from_account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(30);

    const { data: claimsIn } = await supabase
      .from('claims')
      .select(
        'id, from_account_id, to_account_id, to_wa_hint, amount_eth, status, hold_tx_hash, refund_tx_hash, claim_tx_hash, created_at, claimed_at'
      )
      .eq('to_account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(30);

    const claimMap = new Map<string, Record<string, unknown>>();
    for (const c of [...(claimsOut || []), ...(claimsIn || [])]) {
      claimMap.set(String(c.id), c as Record<string, unknown>);
    }

    const items: ActivityItem[] = [
      ...transferRows.map((r) => mapTransferRow(r as Record<string, unknown>)),
      ...Array.from(claimMap.values()).map((c) => mapClaimRow(c, accountId)),
    ];

    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const activity = items.slice(0, 30);

    // Backward-compatible transfers key for older clients
    return NextResponse.json({
      activity,
      transfers: transferRows.slice(0, 30),
      limit: 30,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'History failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
