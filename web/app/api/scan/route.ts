import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { apiErrorBody } from '../../../lib/apiError';
import { ethUsd } from '../../../lib/ethUsd.ts';
import {
  FEED_LIMIT,
  mergeFeed,
  parseScanFocus,
  scanClaimItem,
  scanTransferItem,
  type ClaimScanRow,
  type ScanFocus,
  type TransferScanRow,
} from '../../../lib/flizyFeed.ts';

const ROUTE = 'GET /api/scan';

const TRANSFER_COLUMNS =
  'id, account_id, amount_eth, to_address, status, tx_hash, created_at, phone, kind, asset, counterparty_label, amount_secondary, asset_secondary, note';

const CLAIM_COLUMNS =
  'id, from_account_id, to_channel, to_display_handle, to_wa_hint, to_email, amount_eth, asset, status, hold_tx_hash, refund_tx_hash, claim_tx_hash, created_at, claimed_at';

const CLAIM_FOCUS_COLUMNS = `${CLAIM_COLUMNS}, to_account_id`;

type Named = { id?: string | null; account_id?: string | null; from_account_id?: string | null };
type QueryResult<T> = { data: T[] | null; error: { message?: string } | null };

function accountIds(rows: Named[], key: 'account_id' | 'from_account_id'): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = String(row[key] || '');
    if (/^[0-9a-f-]{36}$/i.test(id)) ids.add(id);
  }
  return [...ids];
}

/**
 * ilike treats % and _ as wildcards. A stored wallet is only used as a
 * lookup key when it is a real address, and the key is matched whole.
 */
function storedAddress(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : null;
}

function dedupe<T extends { id?: string | number | null }>(groups: T[][]): T[] {
  const seen = new Set<string>();
  const rows: T[] = [];
  for (const group of groups) {
    for (const row of group) {
      const id = String(row.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
  }
  return rows;
}

async function namesFor(
  supabase: ReturnType<typeof getSupabase>,
  transferRows: Named[],
  claimRows: Named[]
): Promise<Map<string, string | null>> {
  const ids = [...new Set([...accountIds(transferRows, 'account_id'), ...accountIds(claimRows, 'from_account_id')])];
  const names = new Map<string, string | null>();
  if (ids.length === 0) return names;
  const accounts = await supabase.from('accounts').select('id, username').in('id', ids);
  if (accounts.error) return names;
  for (const account of accounts.data || []) {
    names.set(String(account.id), account.username ?? null);
  }
  return names;
}

function toActivity(transferRows: Array<TransferScanRow & Named>, claimRows: Array<ClaimScanRow & Named>, names: Map<string, string | null>) {
  return mergeFeed([
    ...transferRows.map((row) => scanTransferItem(row, names.get(String(row.account_id || '')))),
    ...claimRows.map((row) => scanClaimItem(row, names.get(String(row.from_account_id || '')))),
  ]);
}

async function loadGeneral(supabase: ReturnType<typeof getSupabase>) {
  const [transfers, claims] = await Promise.all([
    supabase.from('transfers').select(TRANSFER_COLUMNS).order('created_at', { ascending: false }).limit(FEED_LIMIT),
    supabase.from('claims').select(CLAIM_COLUMNS).order('created_at', { ascending: false }).limit(FEED_LIMIT),
  ]);
  if (transfers.error || claims.error) return { error: transfers.error || claims.error };
  const transferRows = (transfers.data || []) as Array<TransferScanRow & Named>;
  const claimRows = (claims.data || []) as Array<ClaimScanRow & Named>;
  const names = await namesFor(supabase, transferRows, claimRows);
  return { activity: toActivity(transferRows, claimRows, names), found: null as boolean | null };
}

async function loadUsername(supabase: ReturnType<typeof getSupabase>, username: string) {
  const account = await supabase
    .from('accounts')
    .select('id, username, agent_wallet_address')
    .eq('username', username)
    .maybeSingle();
  if (account.error) return { error: account.error };
  if (!account.data?.id) return { activity: [], found: false as boolean | null };
  const focusAccountId = String(account.data.id);
  const wallet = storedAddress(account.data.agent_wallet_address);
  const [sent, received, claimsOut, claimsIn, labelled] = await Promise.all([
    supabase.from('transfers').select(TRANSFER_COLUMNS).eq('account_id', focusAccountId).order('created_at', { ascending: false }).limit(FEED_LIMIT),
    wallet
      ? supabase.from('transfers').select(TRANSFER_COLUMNS).ilike('to_address', wallet).order('created_at', { ascending: false }).limit(FEED_LIMIT)
      : Promise.resolve({ data: [], error: null } as QueryResult<TransferScanRow>),
    supabase.from('claims').select(CLAIM_FOCUS_COLUMNS).eq('from_account_id', focusAccountId).order('created_at', { ascending: false }).limit(FEED_LIMIT),
    supabase.from('claims').select(CLAIM_FOCUS_COLUMNS).eq('to_account_id', focusAccountId).order('created_at', { ascending: false }).limit(FEED_LIMIT),
    supabase
      .from('transfers')
      .select(TRANSFER_COLUMNS)
      .in('counterparty_label', [username, `@${username}`])
      .order('created_at', { ascending: false })
      .limit(FEED_LIMIT),
  ]);
  const failed = sent.error || received.error || claimsOut.error || claimsIn.error || labelled.error;
  if (failed) return { error: failed };
  const transferRows = dedupe<TransferScanRow & Named>([
    (sent.data || []) as Array<TransferScanRow & Named>,
    (received.data || []) as Array<TransferScanRow & Named>,
    (labelled.data || []) as Array<TransferScanRow & Named>,
  ]);
  const claimRows = dedupe<ClaimScanRow & Named>([
    (claimsOut.data || []) as Array<ClaimScanRow & Named>,
    (claimsIn.data || []) as Array<ClaimScanRow & Named>,
  ]);
  const names = await namesFor(supabase, transferRows, claimRows);
  names.set(focusAccountId, account.data.username ?? username);
  return { activity: toActivity(transferRows, claimRows, names), found: true as boolean | null };
}

async function loadAddress(supabase: ReturnType<typeof getSupabase>, address: string) {
  const exact = storedAddress(address);
  if (!exact) return { activity: [], found: true as boolean | null };
  // One wallet belongs to one account. The limit only bounds a bad row.
  const owners = await supabase.from('accounts').select('id, username').ilike('agent_wallet_address', exact).limit(8);
  if (owners.error) return { error: owners.error };
  const ownerRows = owners.data || [];
  const sentGroups = await Promise.all(
    ownerRows.map((owner) =>
      supabase.from('transfers').select(TRANSFER_COLUMNS).eq('account_id', String(owner.id)).order('created_at', { ascending: false }).limit(FEED_LIMIT)
    )
  );
  const [received, labelled] = await Promise.all([
    supabase.from('transfers').select(TRANSFER_COLUMNS).ilike('to_address', exact).order('created_at', { ascending: false }).limit(FEED_LIMIT),
    supabase.from('transfers').select(TRANSFER_COLUMNS).ilike('counterparty_label', exact).order('created_at', { ascending: false }).limit(FEED_LIMIT),
  ]);
  const failed = sentGroups.find((group) => group.error)?.error || received.error || labelled.error;
  if (failed) return { error: failed };
  const transferRows = dedupe<TransferScanRow & Named>([
    ...sentGroups.map((group) => (group.data || []) as Array<TransferScanRow & Named>),
    (received.data || []) as Array<TransferScanRow & Named>,
    (labelled.data || []) as Array<TransferScanRow & Named>,
  ]);
  const names = await namesFor(supabase, transferRows, []);
  for (const owner of ownerRows) names.set(String(owner.id), owner.username ?? null);
  return { activity: toActivity(transferRows, [], names), found: true as boolean | null };
}

export async function GET(request: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const supabase = getSupabase();
    const focus: ScanFocus | null = parseScanFocus(new URL(request.url).searchParams.get('q') || '');
    const loaded =
      focus?.kind === 'username'
        ? await loadUsername(supabase, focus.username)
        : focus?.kind === 'address'
          ? await loadAddress(supabase, focus.address)
          : await loadGeneral(supabase);
    if ('error' in loaded && loaded.error) {
      return NextResponse.json(apiErrorBody(ROUTE, loaded.error), { status: 500 });
    }

    const usdPerEth = await ethUsd().catch(() => null);
    const body: { activity: ReturnType<typeof toActivity>; usdPerEth: number | null; limit: number; found?: boolean } = {
      activity: loaded.activity || [],
      usdPerEth,
      limit: FEED_LIMIT,
    };
    if (typeof loaded.found === 'boolean') body.found = loaded.found;
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
