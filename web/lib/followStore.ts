/**
 * Reads and writes for follows.
 *
 * The session route decides who is asking. This file loads that account's
 * row and returns only the public profile shape. Account ids stay here.
 */

import { isMissingClosureColumn } from './accountClosure.ts';
import { summarizeAccountStats, type StatsRow } from './accountStats.ts';
import { ClientError } from './apiError.ts';
import {
  decideFollow,
  publicPerson,
  publicProfile,
  publicSwap,
  type ProfilePayload,
  type PublicPerson,
} from './follows.ts';
import { getSupabase } from './supabase.ts';
import { validateUsername } from './username.ts';

const ACCOUNT_PUBLIC =
  'id, username, display_name, profile_show_social, profile_show_stats, profile_show_activity';
const ACCOUNT_COLS = `${ACCOUNT_PUBLIC}, deactivated_at, deleted_at`;

type Db = ReturnType<typeof getSupabase>;

type AccountHit = {
  id: string;
  username: string | null;
  display_name: string | null;
  deactivated_at?: string | null;
  deleted_at?: string | null;
  profile_show_social: boolean | null;
  profile_show_stats: boolean | null;
  profile_show_activity: boolean | null;
};

export type FollowWriteResult =
  | {
      ok: true;
      following: boolean;
      alerts: boolean;
      copyTrade: boolean;
      followers: number;
      followingCount: number;
    }
  | { ok: false; status: number; error: string };

export type OwnSocial = {
  followers: number;
  following: number;
  showSocial: boolean;
  showStats: boolean;
  showActivity: boolean;
};

function mapDb(error: { message?: string } | null): Error {
  const msg = String(error?.message || '');
  if (/account_follows|profile_show_social|profile_show_stats|profile_show_activity|copy_trade/i.test(msg)) {
    return new ClientError('Follows are not available yet.');
  }
  return new Error(msg || 'follow read failed');
}

function isOpen(row: AccountHit | null | undefined): row is AccountHit {
  return Boolean(row && row.username && !row.deactivated_at && !row.deleted_at);
}

async function lookup(supabase: Db, username: string): Promise<AccountHit | null> {
  let result = await supabase.from('accounts').select(ACCOUNT_COLS).eq('username', username).maybeSingle();
  // Pause columns are optional. When they are absent the account stays open,
  // which is the same rule the session uses.
  if (result.error && isMissingClosureColumn(result.error)) {
    result = (await supabase.from('accounts').select(ACCOUNT_PUBLIC).eq('username', username).maybeSingle()) as typeof result;
  }
  if (result.error) throw mapDb(result.error);
  return (result.data as AccountHit | null) ?? null;
}

async function countsFor(supabase: Db, accountId: string): Promise<{ followers: number; followingCount: number }> {
  const [followers, following] = await Promise.all([
    supabase.from('account_follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', accountId),
    supabase.from('account_follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', accountId),
  ]);
  if (followers.error) throw mapDb(followers.error);
  if (following.error) throw mapDb(following.error);
  return { followers: followers.count || 0, followingCount: following.count || 0 };
}

async function relation(
  supabase: Db,
  viewerId: string,
  targetId: string
): Promise<{ following: boolean; alerts: boolean; copyTrade: boolean }> {
  const { data, error } = await supabase
    .from('account_follows')
    .select('alerts, copy_trade')
    .eq('follower_id', viewerId)
    .eq('following_id', targetId)
    .maybeSingle();
  if (error) throw mapDb(error);
  if (!data) return { following: false, alerts: true, copyTrade: false };
  const row = data as { alerts?: boolean; copy_trade?: boolean };
  return { following: true, alerts: row.alerts !== false, copyTrade: row.copy_trade === true };
}

async function accountsByIds(supabase: Db, ids: string[]): Promise<Map<string, AccountHit>> {
  const map = new Map<string, AccountHit>();
  if (!ids.length) return map;
  let result = await supabase.from('accounts').select(ACCOUNT_COLS).in('id', ids);
  if (result.error && isMissingClosureColumn(result.error)) {
    result = (await supabase.from('accounts').select(ACCOUNT_PUBLIC).in('id', ids)) as typeof result;
  }
  if (result.error) throw mapDb(result.error);
  const { data } = result;
  for (const row of (data || []) as AccountHit[]) map.set(row.id, row);
  return map;
}

function peopleFrom(
  rows: Array<{ username?: string | null; display_name?: string | null; deactivated_at?: string | null; deleted_at?: string | null }>
): PublicPerson[] {
  const out: PublicPerson[] = [];
  for (const row of rows) {
    if (!row || row.deactivated_at || row.deleted_at) continue;
    const person = publicPerson(row);
    if (person) out.push(person);
  }
  return out;
}

async function trading(supabase: Db, accountId: string): Promise<{ swaps: number; volumeEth: number; activity: ProfilePayload['activity'] }> {
  const [stats, recent] = await Promise.all([
    supabase
      .from('transfers')
      .select('kind, status, asset, amount_eth, amount_secondary, asset_secondary')
      .eq('account_id', accountId)
      .eq('status', 'confirmed')
      .limit(2000),
    supabase
      .from('transfers')
      .select('kind, status, asset, asset_secondary, created_at')
      .eq('account_id', accountId)
      .eq('status', 'confirmed')
      .eq('kind', 'swap')
      .order('created_at', { ascending: false })
      .limit(8),
  ]);
  if (stats.error) throw mapDb(stats.error);
  if (recent.error) throw mapDb(recent.error);
  const summary = summarizeAccountStats((stats.data || []) as StatsRow[]);
  const activity = ((recent.data || []) as Array<{ kind?: string; status?: string; asset?: string; asset_secondary?: string; created_at?: string }>)
    .map((row) => publicSwap(row))
    .filter((row): row is NonNullable<typeof row> => row !== null);
  return { swaps: summary.swaps, volumeEth: summary.volumeEth, activity };
}

async function followedBy(supabase: Db, viewerId: string, targetId: string): Promise<{ people: PublicPerson[]; capped: boolean }> {
  const mine = await supabase.from('account_follows').select('following_id').eq('follower_id', viewerId).limit(1000);
  if (mine.error) throw mapDb(mine.error);
  const ids = ((mine.data || []) as Array<{ following_id: string }>)
    .map((row) => row.following_id)
    .filter((id) => id && id !== targetId);
  if (!ids.length) return { people: [], capped: false };
  const edges = await supabase
    .from('account_follows')
    .select('follower_id')
    .eq('following_id', targetId)
    .in('follower_id', ids)
    .limit(8);
  if (edges.error) throw mapDb(edges.error);
  const followerIds = ((edges.data || []) as Array<{ follower_id: string }>).map((row) => row.follower_id);
  const accounts = await accountsByIds(supabase, followerIds);
  const people = peopleFrom(followerIds.map((id) => accounts.get(id)).filter((row): row is AccountHit => Boolean(row)));
  return { people, capped: (edges.data || []).length >= 8 };
}

/** The public profile, or null when that username is not an open account. */
export async function loadProfile(rawUsername: string, viewerId: string | null): Promise<ProfilePayload | null> {
  const checked = validateUsername(rawUsername);
  if (!checked.ok) return null;
  const supabase = getSupabase();
  const target = await lookup(supabase, checked.username);
  if (!isOpen(target)) return null;
  const person = publicPerson(target);
  if (!person) return null;

  const isSelf = viewerId === target.id;
  const showSocial = target.profile_show_social !== false;
  const showStats = target.profile_show_stats !== false;
  const showActivity = target.profile_show_activity === true;
  const [counts, rel, trade, socialProof] = await Promise.all([
    countsFor(supabase, target.id),
    viewerId && !isSelf
      ? relation(supabase, viewerId, target.id)
      : Promise.resolve({ following: false, alerts: true, copyTrade: false }),
    isSelf || showStats || showActivity
      ? trading(supabase, target.id)
      : Promise.resolve({ swaps: 0, volumeEth: 0, activity: [] }),
    viewerId && (isSelf || showSocial) ? followedBy(supabase, viewerId, target.id) : Promise.resolve({ people: [], capped: false }),
  ]);

  return publicProfile({
    username: person.username,
    displayName: person.displayName,
    isSelf,
    signedIn: Boolean(viewerId),
    following: rel.following,
    alerts: rel.alerts,
    copyTrade: rel.copyTrade,
    showSocial,
    showStats,
    showActivity,
    followers: counts.followers,
    followingCount: counts.followingCount,
    swaps: trade.swaps,
    volumeEth: trade.volumeEth,
    activity: isSelf || showActivity ? trade.activity : [],
    followedBy: socialProof.people,
    followedByCapped: socialProof.capped,
  });
}

async function openTarget(rawUsername: string): Promise<{ supabase: Db; target: AccountHit } | FollowWriteResult> {
  const checked = validateUsername(rawUsername);
  if (!checked.ok) return { ok: false, status: 404, error: 'No profile with that username.' };
  const supabase = getSupabase();
  const target = await lookup(supabase, checked.username);
  if (!isOpen(target)) return { ok: false, status: 404, error: 'No profile with that username.' };
  return { supabase, target };
}

/** Follow, unfollow, or save alerts or the copy choice. Counts are read after the write. */
export async function changeFollow(
  viewerId: string,
  rawUsername: string,
  action: 'follow' | 'unfollow' | 'alerts' | 'copy',
  value?: boolean
): Promise<FollowWriteResult> {
  const found = await openTarget(rawUsername);
  if (!('target' in found)) return found;
  const { supabase, target } = found;
  const rel = await relation(supabase, viewerId, target.id);
  const decision = decideFollow({
    viewerId,
    targetId: target.id,
    targetOpen: true,
    already: rel.following,
    action,
  });
  if (!decision.ok) return decision;

  if (decision.write === 'insert') {
    const { error } = await supabase.from('account_follows').upsert(
      { follower_id: viewerId, following_id: target.id, alerts: true },
      { onConflict: 'follower_id,following_id', ignoreDuplicates: true }
    );
    if (error) {
      if (/account_follows_cap/.test(error.message || '')) {
        const again = await relation(supabase, viewerId, target.id);
        if (!again.following) {
          return { ok: false, status: 409, error: 'You can follow up to 1000 people.' };
        }
      } else {
        throw mapDb(error);
      }
    }
  } else if (decision.write === 'delete') {
    const { error } = await supabase
      .from('account_follows')
      .delete()
      .eq('follower_id', viewerId)
      .eq('following_id', target.id);
    if (error) throw mapDb(error);
  } else if (decision.write === 'alerts' || decision.write === 'copy') {
    const patch = decision.write === 'copy' ? { copy_trade: value === true } : { alerts: value === true };
    const { data, error } = await supabase
      .from('account_follows')
      .update(patch)
      .eq('follower_id', viewerId)
      .eq('following_id', target.id)
      .select('alerts, copy_trade')
      .maybeSingle();
    if (error) throw mapDb(error);
    if (!data) return { ok: false, status: 409, error: 'Follow them first.' };
  }

  const [next, counts] = await Promise.all([
    relation(supabase, viewerId, target.id),
    countsFor(supabase, target.id),
  ]);
  return {
    ok: true,
    following: next.following,
    alerts: next.alerts,
    copyTrade: next.copyTrade,
    followers: counts.followers,
    followingCount: counts.followingCount,
  };
}

/** Followers or following, newest first. A prefix narrows the usernames. */
export async function listFollows(
  rawUsername: string,
  side: 'followers' | 'following',
  prefix: string,
  viewerId: string | null
): Promise<{ people: PublicPerson[] } | { error: string; status: number }> {
  const checked = validateUsername(rawUsername);
  if (!checked.ok) return { error: 'No profile with that username.', status: 404 };
  const supabase = getSupabase();
  const target = await lookup(supabase, checked.username);
  if (!isOpen(target)) return { error: 'No profile with that username.', status: 404 };
  const isSelf = viewerId === target.id;
  if (!isSelf && target.profile_show_social === false) {
    return { error: 'This list is private.', status: 404 };
  }

  const edgeColumn = side === 'followers' ? 'follower_id' : 'following_id';
  const ownerColumn = side === 'followers' ? 'following_id' : 'follower_id';

  if (prefix) {
    let named = await supabase
      .from('accounts')
      .select(ACCOUNT_COLS)
      .ilike('username', `${prefix}%`)
      .is('deactivated_at', null)
      .is('deleted_at', null)
      .limit(40);
    if (named.error && isMissingClosureColumn(named.error)) {
      named = (await supabase
        .from('accounts')
        .select(ACCOUNT_PUBLIC)
        .ilike('username', `${prefix}%`)
        .limit(40)) as typeof named;
    }
    if (named.error) throw mapDb(named.error);
    const rows = ((named.data || []) as AccountHit[]).filter((row) => isOpen(row));
    const ids = rows.map((row) => row.id);
    if (!ids.length) return { people: [] };
    const edges = await supabase
      .from('account_follows')
      .select(`${edgeColumn}, created_at`)
      .eq(ownerColumn, target.id)
      .in(edgeColumn, ids)
      .order('created_at', { ascending: false })
      .limit(40);
    if (edges.error) throw mapDb(edges.error);
    const order = ((edges.data || []) as Array<Record<string, string>>).map((row) => row[edgeColumn]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return { people: peopleFrom(order.map((id) => byId.get(id)).filter((row): row is AccountHit => Boolean(row))) };
  }

  const edges = await supabase
    .from('account_follows')
    .select(`${edgeColumn}, created_at`)
    .eq(ownerColumn, target.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (edges.error) throw mapDb(edges.error);
  const ids = ((edges.data || []) as Array<Record<string, string>>).map((row) => row[edgeColumn]);
  const accounts = await accountsByIds(supabase, ids);
  return { people: peopleFrom(ids.map((id) => accounts.get(id)).filter((row): row is AccountHit => Boolean(row))) };
}

/** Username prefix search. Two characters, already checked by the route. */
export async function searchPeople(prefix: string): Promise<PublicPerson[]> {
  const supabase = getSupabase();
  let result = await supabase
    .from('accounts')
    .select('username, display_name, deactivated_at, deleted_at')
    .ilike('username', `${prefix}%`)
    .is('deactivated_at', null)
    .is('deleted_at', null)
    .order('username', { ascending: true })
    .limit(20);
  if (result.error && isMissingClosureColumn(result.error)) {
    result = (await supabase
      .from('accounts')
      .select('username, display_name')
      .ilike('username', `${prefix}%`)
      .order('username', { ascending: true })
      .limit(20)) as typeof result;
  }
  if (result.error) throw mapDb(result.error);
  return peopleFrom((result.data || []) as AccountHit[]);
}

/**
 * People who already have a follow, newest edges first.
 * Skips the viewer and anyone they already follow. An empty graph returns nobody,
 * rather than a list of every account.
 */
export async function suggestPeople(viewerId: string | null): Promise<PublicPerson[]> {
  const supabase = getSupabase();
  const skip = new Set<string>();
  if (viewerId) {
    skip.add(viewerId);
    const mine = await supabase.from('account_follows').select('following_id').eq('follower_id', viewerId).limit(1000);
    if (mine.error) throw mapDb(mine.error);
    for (const row of (mine.data || []) as Array<{ following_id: string }>) skip.add(row.following_id);
  }
  const edges = await supabase
    .from('account_follows')
    .select('following_id')
    .order('created_at', { ascending: false })
    .limit(40);
  if (edges.error) throw mapDb(edges.error);
  const ids: string[] = [];
  for (const row of (edges.data || []) as Array<{ following_id: string }>) {
    if (!row.following_id || skip.has(row.following_id) || ids.includes(row.following_id)) continue;
    ids.push(row.following_id);
    if (ids.length >= 8) break;
  }
  const accounts = await accountsByIds(supabase, ids);
  return peopleFrom(ids.map((id) => accounts.get(id)).filter((row): row is AccountHit => Boolean(row)));
}

/** Counts and visibility for the signed-in account's own screen. */
export async function ownSocial(accountId: string): Promise<OwnSocial> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('accounts')
    .select('profile_show_social, profile_show_stats, profile_show_activity')
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw mapDb(error);
  const counts = await countsFor(supabase, accountId);
  const row = data as {
    profile_show_social?: boolean | null;
    profile_show_stats?: boolean | null;
    profile_show_activity?: boolean | null;
  } | null;
  return {
    followers: counts.followers,
    following: counts.followingCount,
    showSocial: row?.profile_show_social !== false,
    showStats: row?.profile_show_stats !== false,
    showActivity: row?.profile_show_activity === true,
  };
}

export async function setProfileVisibility(
  accountId: string,
  patch: { showSocial?: boolean; showStats?: boolean; showActivity?: boolean }
): Promise<OwnSocial> {
  const update: { profile_show_social?: boolean; profile_show_stats?: boolean; profile_show_activity?: boolean } = {};
  if (typeof patch.showSocial === 'boolean') update.profile_show_social = patch.showSocial;
  if (typeof patch.showStats === 'boolean') update.profile_show_stats = patch.showStats;
  if (typeof patch.showActivity === 'boolean') update.profile_show_activity = patch.showActivity;
  const supabase = getSupabase();
  if (Object.keys(update).length) {
    const { error } = await supabase.from('accounts').update(update).eq('id', accountId);
    if (error) throw mapDb(error);
  }
  return ownSocial(accountId);
}
