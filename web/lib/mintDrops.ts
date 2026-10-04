/**
 * Flizy Mint data: the nft_drops rows and a drop's allowlist.
 *
 * Every function takes an optional Supabase client as its last argument and
 * falls back to getSupabase(), the seam web/lib/tasks.ts uses. Parsing what a
 * creator pastes lives in web/lib/mintInput.ts (test/mintInput.test.js); the
 * database calls here have no unit tests of their own.
 *
 * Allowlist rules:
 *   - A Flizy username resolves to that account's wallet when it is saved.
 *     A later username change does not move the slot; the username is only
 *     a label.
 *   - One row per wallet. Adding a wallet again replaces its allowance.
 *   - The stored allowlist_root is the root of the rows right now. It is what
 *     the creator publishes to FlizyDrop; the page compares it with the root
 *     on chain to say whether the published list is current.
 */

import { ethers } from 'ethers';
import { getSupabase } from './supabase';
import { walletForAccount } from './nftApi.ts';
import { allowlistRoot, type AllowlistEntry } from './mintMerkle.ts';
import type { ExternalMintFn } from './mintExternal.ts';
import { ALLOWLIST_MAX } from './mintInput.ts';

export { ALLOWLIST_BATCH_MAX, ALLOWLIST_MAX, parseAllowlistInput, type ParsedAllowlist } from './mintInput.ts';

export type Db = ReturnType<typeof getSupabase>;

function db(client?: Db): Db {
  return client ?? getSupabase();
}

export type DropRow = {
  id: string;
  collection: string;
  mode: 'flizy' | 'external';
  creator_account_id: string | null;
  name: string;
  description: string | null;
  image_url: string | null;
  banner_url: string | null;
  external_mint_fn: ExternalMintFn | null;
  allowlist_root: string | null;
  created_at: string;
};

const DROP_COLUMNS =
  'id, collection, mode, creator_account_id, name, description, image_url, banner_url, external_mint_fn, allowlist_root, created_at';

/** Most drops any listing returns. */
const LIST_LIMIT = 200;

export async function getDrop(collection: string, client?: Db): Promise<DropRow | null> {
  const { data, error } = await db(client)
    .from('nft_drops')
    .select(DROP_COLUMNS)
    .eq('collection', ethers.getAddress(collection))
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as DropRow | null) ?? null;
}

export async function listDrops(client?: Db): Promise<DropRow[]> {
  const { data, error } = await db(client)
    .from('nft_drops')
    .select(DROP_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(error.message);
  return (data as DropRow[]) ?? [];
}

export async function creatorDrops(accountId: string, client?: Db): Promise<DropRow[]> {
  const { data, error } = await db(client)
    .from('nft_drops')
    .select(DROP_COLUMNS)
    .eq('creator_account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(error.message);
  return (data as DropRow[]) ?? [];
}

export type NewDrop = {
  collection: string;
  mode: 'flizy' | 'external';
  creatorAccountId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  bannerUrl: string | null;
  externalMintFn: ExternalMintFn | null;
};

/** Insert a drop. Returns null when the collection already has one. */
export async function insertDrop(d: NewDrop, client?: Db): Promise<DropRow | null> {
  const { data, error } = await db(client)
    .from('nft_drops')
    .insert({
      collection: ethers.getAddress(d.collection),
      mode: d.mode,
      creator_account_id: d.creatorAccountId,
      name: d.name,
      description: d.description,
      image_url: d.imageUrl,
      banner_url: d.bannerUrl,
      external_mint_fn: d.externalMintFn,
    })
    .select(DROP_COLUMNS)
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === '23505') return null;
    throw new Error(error.message);
  }
  return (data as DropRow | null) ?? null;
}

// -------------------------------------------------------------- allowlist

export type AllowlistRow = {
  address: string;
  allowance: number;
  source: 'username' | 'address' | 'csv';
  username: string | null;
};

export async function listAllowlist(dropId: string, client?: Db): Promise<AllowlistRow[]> {
  const rows: AllowlistRow[] = [];
  const page = 1000;
  for (let from = 0; from < ALLOWLIST_MAX; from += page) {
    const { data, error } = await db(client)
      .from('nft_drop_allowlist')
      .select('address, allowance, source, username')
      .eq('drop_id', dropId)
      .order('address', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const batch = (data as AllowlistRow[]) ?? [];
    rows.push(...batch);
    if (batch.length < page) break;
  }
  return rows;
}

export type ResolvedUsername = { username: string; accountId: string; address: string; allowance: number };

/** Flizy usernames to wallets, now. Unknown names come back in `unknown`. */
export async function resolveUsernames(
  entries: Array<{ username: string; allowance: number }>,
  client?: Db
): Promise<{ resolved: ResolvedUsername[]; unknown: string[] }> {
  if (!entries.length) return { resolved: [], unknown: [] };
  const names = entries.map((e) => e.username);
  const { data, error } = await db(client)
    .from('accounts')
    .select('id, username, agent_wallet_address')
    .in('username', names);
  if (error) throw new Error(error.message);
  const byName = new Map<string, { id: string; agent_wallet_address: string | null }>();
  for (const row of (data as Array<{ id: string; username: string; agent_wallet_address: string | null }>) ?? []) {
    byName.set(String(row.username).toLowerCase(), row);
  }
  const resolved: ResolvedUsername[] = [];
  const unknown: string[] = [];
  for (const e of entries) {
    const row = byName.get(e.username);
    if (!row) {
      unknown.push(e.username);
      continue;
    }
    resolved.push({
      username: e.username,
      accountId: row.id,
      address: walletForAccount(row.id, row.agent_wallet_address).address,
      allowance: e.allowance,
    });
  }
  return { resolved, unknown };
}

/** Recompute and store the root of the drop's current rows. Returns it. */
export async function refreshAllowlistRoot(drop: DropRow, client?: Db): Promise<string> {
  const rows = await listAllowlist(drop.id, client);
  const entries: AllowlistEntry[] = rows.map((r) => ({ wallet: r.address, allowance: r.allowance }));
  const root = allowlistRoot(drop.collection, entries);
  const { error } = await db(client)
    .from('nft_drops')
    .update({ allowlist_root: root, updated_at: new Date().toISOString() })
    .eq('id', drop.id);
  if (error) throw new Error(error.message);
  return root;
}

/** Upsert entries (one row per wallet; a repeat replaces the allowance). */
export async function addAllowlistRows(
  dropId: string,
  rows: Array<{ address: string; allowance: number; source: AllowlistRow['source']; accountId?: string; username?: string }>,
  client?: Db
): Promise<void> {
  if (!rows.length) return;
  const { error } = await db(client)
    .from('nft_drop_allowlist')
    .upsert(
      rows.map((r) => ({
        drop_id: dropId,
        address: ethers.getAddress(r.address),
        allowance: r.allowance,
        source: r.source,
        account_id: r.accountId ?? null,
        username: r.username ?? null,
      })),
      { onConflict: 'drop_id,address' }
    );
  if (error) {
    if (/nft_drop_allowlist_cap/.test(error.message)) {
      throw new AllowlistFullError();
    }
    throw new Error(error.message);
  }
}

export class AllowlistFullError extends Error {
  constructor() {
    super(`An allowlist holds at most ${ALLOWLIST_MAX} wallets.`);
  }
}

/** Remove entries by wallet address, or by the Flizy username they were added under. */
export async function removeAllowlistRows(
  dropId: string,
  keys: { addresses: string[]; usernames: string[] },
  client?: Db
): Promise<void> {
  if (keys.addresses.length) {
    const { error } = await db(client)
      .from('nft_drop_allowlist')
      .delete()
      .eq('drop_id', dropId)
      .in('address', keys.addresses.map((a) => ethers.getAddress(a)));
    if (error) throw new Error(error.message);
  }
  if (keys.usernames.length) {
    const { error } = await db(client)
      .from('nft_drop_allowlist')
      .delete()
      .eq('drop_id', dropId)
      .eq('source', 'username')
      .in('username', keys.usernames);
    if (error) throw new Error(error.message);
  }
}

/** The viewer's own entry, if listed. */
export async function allowlistEntryFor(dropId: string, address: string, client?: Db): Promise<AllowlistRow | null> {
  const { data, error } = await db(client)
    .from('nft_drop_allowlist')
    .select('address, allowance, source, username')
    .eq('drop_id', dropId)
    .eq('address', ethers.getAddress(address))
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as AllowlistRow | null) ?? null;
}

/** Usernames for a set of account ids, in one query. Accounts without one are left out. */
export async function usernamesOf(accountIds: string[], client?: Db): Promise<Map<string, string>> {
  const ids = [...new Set(accountIds.filter(Boolean))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { data, error } = await db(client).from('accounts').select('id, username').in('id', ids);
  if (error) throw new Error(error.message);
  for (const row of (data as Array<{ id: string; username: string | null }>) ?? []) {
    if (row.username) out.set(row.id, row.username);
  }
  return out;
}

/** Most drops one account may have on Flizy, so a single account cannot flood the Mint list. */
export const MAX_DROPS_PER_ACCOUNT = 50;

export async function creatorDropCount(accountId: string, client?: Db): Promise<number> {
  const { count, error } = await db(client)
    .from('nft_drops')
    .select('id', { count: 'exact', head: true })
    .eq('creator_account_id', accountId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
