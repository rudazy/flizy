import { getSupabase } from './supabase.ts';
import { ClientError } from './apiError.ts';
import { validateUsername } from './username.ts';
import { checkedProjectImage, checkedProjectLinks, type ProjectLink } from './tasks.ts';

/**
 * The social side of a token page: the admin-edited profile, the watchlist,
 * and community theses with likes and comments.
 *
 * Only listed tokens have a page, so only their keys are accepted here; a
 * route cannot be aimed at an arbitrary contract to create rows for it. Every
 * reply names people by @username and never by account id.
 */

export type Db = ReturnType<typeof getSupabase>;

function db(client?: Db): Db {
  return client ?? getSupabase();
}

/** Tokens with a page. Mirrors the one symbol /api/tokens/[symbol] accepts. */
export const LISTED_TOKENS = ['flz'] as const;
export type TokenKey = (typeof LISTED_TOKENS)[number];

export function listedTokenKey(raw: unknown): TokenKey | null {
  const key = String(raw ?? '').trim().toLowerCase();
  return LISTED_TOKENS.find((t) => t === key) ?? null;
}

function requireKey(raw: unknown): TokenKey {
  const key = listedTokenKey(raw);
  if (!key) throw new ClientError('This token is not listed.');
  return key;
}

export const SENTIMENTS = ['bullish', 'neutral', 'bearish'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const THESIS_MAX = 500;
export const COMMENT_MAX = 300;
export const DESCRIPTION_MAX = 500;
export const MAX_TOKEN_LINKS = 8;
/** Per account, per token, in 24 hours. */
export const THESES_PER_TOKEN_PER_DAY = 3;
/** Per account, across tokens, in 24 hours. */
export const THESES_PER_DAY = 10;
export const COMMENTS_PER_HOUR = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const THESIS_NOT_FOUND = 'That thesis is not there any more.';

async function countRows(query: PromiseLike<{ count: number | null; error: { message: string } | null }>) {
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count || 0;
}

async function isAdmin(accountId: string, supabase: Db): Promise<boolean> {
  const { data, error } = await supabase.from('accounts').select('is_admin').eq('id', accountId).maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data && (data as { is_admin?: boolean | null }).is_admin === true);
}

async function usernameOf(accountId: string, supabase: Db): Promise<string | null> {
  const { data, error } = await supabase.from('accounts').select('username').eq('id', accountId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { username?: string | null } | null)?.username || null;
}

async function usernames(ids: string[], supabase: Db): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { data, error } = await supabase.from('accounts').select('id, username').in('id', [...new Set(ids)]);
  if (error) throw new Error(error.message);
  return new Map(((data || []) as Array<{ id: string; username: string | null }>).map((a) => [String(a.id), a.username || 'someone']));
}

/** Whether this account may edit token profiles: Flizy admins. */
export async function canEditTokenProfile(accountId: string, client?: Db): Promise<boolean> {
  return isAdmin(accountId, db(client));
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export type TokenProfile = {
  logo: string | null;
  description: string;
  links: ProjectLink[];
  creatorUsername: string | null;
};

const EMPTY_PROFILE: TokenProfile = { logo: null, description: '', links: [], creatorUsername: null };

export async function getTokenProfile(rawKey: string, client?: Db): Promise<TokenProfile> {
  const key = requireKey(rawKey);
  const { data, error } = await db(client)
    .from('token_profiles')
    .select('logo, description, links, creator_username')
    .eq('token_key', key)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return EMPTY_PROFILE;
  const row = data as { logo: string | null; description: string | null; links: unknown; creator_username: string | null };
  return {
    logo: row.logo || null,
    description: String(row.description || ''),
    // Stored links were checked on the way in; anything else is dropped.
    links: Array.isArray(row.links) ? (row.links as ProjectLink[]).filter((l) => l && /^https:\/\//i.test(String(l.url))) : [],
    creatorUsername: row.creator_username || null,
  };
}

export type TokenProfilePatch = {
  logo?: string | null;
  description?: string;
  links?: ProjectLink[];
  creatorUsername?: string | null;
};

/** Admins only. Fields left out are not changed. */
export async function updateTokenProfile(
  accountId: string,
  rawKey: string,
  patch: TokenProfilePatch,
  client?: Db
): Promise<TokenProfile> {
  const key = requireKey(rawKey);
  const supabase = db(client);
  if (!(await isAdmin(accountId, supabase))) throw new ClientError('Only Flizy admins can edit a token profile.');

  const update: Record<string, unknown> = {};
  if (patch.logo !== undefined) update.logo = checkedProjectImage(patch.logo);
  if (patch.description !== undefined) {
    const description = String(patch.description || '').trim();
    if (description.length > DESCRIPTION_MAX) throw new ClientError(`Keep the description to ${DESCRIPTION_MAX} characters.`);
    update.description = description;
  }
  if (patch.links !== undefined) {
    const links = checkedProjectLinks(patch.links);
    if (links.length > MAX_TOKEN_LINKS) throw new ClientError(`A token can show ${MAX_TOKEN_LINKS} links.`);
    update.links = links;
  }
  if (patch.creatorUsername !== undefined) {
    const raw = String(patch.creatorUsername || '').trim().replace(/^@/, '');
    if (!raw) {
      update.creator_username = null;
    } else {
      const checked = validateUsername(raw);
      if (!checked.ok) throw new ClientError(checked.error);
      const { data, error } = await supabase.from('accounts').select('id').eq('username', checked.username).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new ClientError('No Flizy account has that username.');
      update.creator_username = checked.username;
    }
  }
  if (Object.keys(update).length) {
    update.updated_at = new Date().toISOString();
    update.updated_by = accountId;
    const { error } = await supabase.from('token_profiles').upsert({ token_key: key, ...update }, { onConflict: 'token_key' });
    if (error) throw new Error(error.message);
  }
  return getTokenProfile(key, supabase);
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

export async function isWatched(accountId: string, rawKey: string, client?: Db): Promise<boolean> {
  const key = requireKey(rawKey);
  const { data, error } = await db(client)
    .from('token_watchlist')
    .select('token_key')
    .eq('account_id', accountId)
    .eq('token_key', key)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

export async function setWatched(accountId: string, rawKey: string, on: boolean, client?: Db): Promise<boolean> {
  const key = requireKey(rawKey);
  const supabase = db(client);
  if (on) {
    const { error } = await supabase
      .from('token_watchlist')
      .upsert({ account_id: accountId, token_key: key }, { onConflict: 'account_id,token_key' });
    if (error) throw new Error(error.message);
    return true;
  }
  const { error } = await supabase.from('token_watchlist').delete().eq('account_id', accountId).eq('token_key', key);
  if (error) throw new Error(error.message);
  return false;
}

export async function listWatched(accountId: string, client?: Db): Promise<TokenKey[]> {
  const { data, error } = await db(client).from('token_watchlist').select('token_key').eq('account_id', accountId);
  if (error) throw new Error(error.message);
  return ((data || []) as Array<{ token_key: string }>)
    .map((r) => listedTokenKey(r.token_key))
    .filter((k): k is TokenKey => k !== null);
}

// ---------------------------------------------------------------------------
// Theses
// ---------------------------------------------------------------------------

export type Thesis = {
  id: string;
  username: string;
  sentiment: Sentiment;
  body: string;
  createdAt: string;
  likes: number;
  comments: number;
  likedByViewer: boolean;
  /** The viewer wrote it, or is an admin: the delete control shows. */
  canDelete: boolean;
};

type ThesisRow = { id: string; account_id: string; sentiment: string; body: string; created_at: string; deleted_at?: string | null };

async function thesesFor(rows: ThesisRow[], viewerId: string, supabase: Db): Promise<Thesis[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [names, counts, liked, admin] = await Promise.all([
    usernames(rows.map((r) => r.account_id), supabase),
    supabase.rpc('token_thesis_counts', { p_ids: ids }),
    supabase.from('token_thesis_likes').select('thesis_id').eq('account_id', viewerId).in('thesis_id', ids),
    isAdmin(viewerId, supabase),
  ]);
  if (counts.error) throw new Error(counts.error.message);
  if (liked.error) throw new Error(liked.error.message);
  const countOf = new Map(
    ((counts.data || []) as Array<{ thesis_id: string; likes: number | string; comments: number | string }>).map((c) => [
      String(c.thesis_id),
      { likes: Number(c.likes) || 0, comments: Number(c.comments) || 0 },
    ])
  );
  const likedIds = new Set(((liked.data || []) as Array<{ thesis_id: string }>).map((l) => String(l.thesis_id)));
  return rows.map((r) => ({
    id: r.id,
    username: names.get(String(r.account_id)) || 'someone',
    sentiment: (SENTIMENTS.find((s) => s === r.sentiment) ?? 'neutral') as Sentiment,
    body: r.body,
    createdAt: r.created_at,
    likes: countOf.get(r.id)?.likes || 0,
    comments: countOf.get(r.id)?.comments || 0,
    likedByViewer: likedIds.has(r.id),
    canDelete: admin || String(r.account_id) === viewerId,
  }));
}

export async function listTheses(
  rawKey: string,
  viewerId: string,
  opts: { limit?: number } = {},
  client?: Db
): Promise<{ theses: Thesis[]; total: number }> {
  const key = requireKey(rawKey);
  const supabase = db(client);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 20, 50));
  const [{ data, error }, total] = await Promise.all([
    supabase
      .from('token_theses')
      .select('id, account_id, sentiment, body, created_at')
      .eq('token_key', key)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit),
    countRows(supabase.from('token_theses').select('id', { count: 'exact', head: true }).eq('token_key', key).is('deleted_at', null)),
  ]);
  if (error) throw new Error(error.message);
  return { theses: await thesesFor((data || []) as ThesisRow[], viewerId, supabase), total };
}

export async function postThesis(
  accountId: string,
  rawKey: string,
  input: { sentiment: string; body: string },
  client?: Db
): Promise<Thesis> {
  const key = requireKey(rawKey);
  const supabase = db(client);
  if (!(await usernameOf(accountId, supabase))) throw new ClientError('Choose a username to post.');
  const sentiment = SENTIMENTS.find((s) => s === String(input.sentiment));
  if (!sentiment) throw new ClientError('Pick Bullish, Neutral or Bearish.');
  const body = String(input.body || '').trim();
  if (!body) throw new ClientError('Write your thesis first.');
  if (body.length > THESIS_MAX) throw new ClientError(`Keep a thesis to ${THESIS_MAX} characters.`);

  // Deleted posts still count, so posting and deleting cannot dodge the limit.
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const [onToken, overall] = await Promise.all([
    countRows(
      supabase
        .from('token_theses')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('token_key', key)
        .gte('created_at', since)
    ),
    countRows(supabase.from('token_theses').select('id', { count: 'exact', head: true }).eq('account_id', accountId).gte('created_at', since)),
  ]);
  if (onToken >= THESES_PER_TOKEN_PER_DAY) {
    throw new ClientError(`You can post ${THESES_PER_TOKEN_PER_DAY} theses on a token a day.`);
  }
  if (overall >= THESES_PER_DAY) throw new ClientError(`You can post ${THESES_PER_DAY} theses a day.`);

  const { data, error } = await supabase
    .from('token_theses')
    .insert({ token_key: key, account_id: accountId, sentiment, body })
    .select('id, account_id, sentiment, body, created_at')
    .single();
  if (error) throw new Error(error.message);
  const [thesis] = await thesesFor([data as ThesisRow], accountId, supabase);
  return thesis;
}

async function liveThesis(rawKey: string, thesisId: string, supabase: Db): Promise<ThesisRow> {
  const key = requireKey(rawKey);
  const { data, error } = await supabase
    .from('token_theses')
    .select('id, account_id, sentiment, body, created_at, deleted_at')
    .eq('id', String(thesisId))
    .eq('token_key', key)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as ThesisRow | null;
  if (!row || row.deleted_at) throw new ClientError(THESIS_NOT_FOUND);
  return row;
}

/** The author or an admin. Hidden, not erased. */
export async function deleteThesis(accountId: string, rawKey: string, thesisId: string, client?: Db): Promise<void> {
  const supabase = db(client);
  const row = await liveThesis(rawKey, thesisId, supabase);
  if (String(row.account_id) !== accountId && !(await isAdmin(accountId, supabase))) {
    throw new ClientError('You can only delete your own thesis.');
  }
  const { error } = await supabase.from('token_theses').update({ deleted_at: new Date().toISOString() }).eq('id', row.id);
  if (error) throw new Error(error.message);
}

/** Like it, or take the like back. One like per account. */
export async function toggleLike(
  accountId: string,
  rawKey: string,
  thesisId: string,
  client?: Db
): Promise<{ liked: boolean; likes: number }> {
  const supabase = db(client);
  const row = await liveThesis(rawKey, thesisId, supabase);
  const { data: existing, error: readErr } = await supabase
    .from('token_thesis_likes')
    .select('thesis_id')
    .eq('thesis_id', row.id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  let liked: boolean;
  if (existing) {
    const { error } = await supabase.from('token_thesis_likes').delete().eq('thesis_id', row.id).eq('account_id', accountId);
    if (error) throw new Error(error.message);
    liked = false;
  } else {
    const { error } = await supabase.from('token_thesis_likes').insert({ thesis_id: row.id, account_id: accountId });
    // A second tap that raced the first finds the like already there.
    if (error && error.code !== '23505') throw new Error(error.message);
    liked = true;
  }
  const likes = await countRows(supabase.from('token_thesis_likes').select('thesis_id', { count: 'exact', head: true }).eq('thesis_id', row.id));
  return { liked, likes };
}

export type ThesisComment = { id: string; username: string; body: string; createdAt: string; canDelete: boolean };

export async function listComments(rawKey: string, thesisId: string, viewerId: string, client?: Db): Promise<ThesisComment[]> {
  const supabase = db(client);
  const row = await liveThesis(rawKey, thesisId, supabase);
  const { data, error } = await supabase
    .from('token_thesis_comments')
    .select('id, account_id, body, created_at')
    .eq('thesis_id', row.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) throw new Error(error.message);
  const rows = (data || []) as Array<{ id: string; account_id: string; body: string; created_at: string }>;
  const [names, admin] = await Promise.all([usernames(rows.map((r) => r.account_id), supabase), isAdmin(viewerId, supabase)]);
  return rows.map((r) => ({
    id: r.id,
    username: names.get(String(r.account_id)) || 'someone',
    body: r.body,
    createdAt: r.created_at,
    canDelete: admin || String(r.account_id) === viewerId,
  }));
}

export async function postComment(
  accountId: string,
  rawKey: string,
  thesisId: string,
  rawBody: string,
  client?: Db
): Promise<ThesisComment> {
  const supabase = db(client);
  const row = await liveThesis(rawKey, thesisId, supabase);
  const username = await usernameOf(accountId, supabase);
  if (!username) throw new ClientError('Choose a username to comment.');
  const body = String(rawBody || '').trim();
  if (!body) throw new ClientError('Write a comment first.');
  if (body.length > COMMENT_MAX) throw new ClientError(`Keep a comment to ${COMMENT_MAX} characters.`);
  const recent = await countRows(
    supabase
      .from('token_thesis_comments')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .gte('created_at', new Date(Date.now() - HOUR_MS).toISOString())
  );
  if (recent >= COMMENTS_PER_HOUR) throw new ClientError('You are commenting very fast. Try again in a while.');

  const { data, error } = await supabase
    .from('token_thesis_comments')
    .insert({ thesis_id: row.id, account_id: accountId, body })
    .select('id, body, created_at')
    .single();
  if (error) throw new Error(error.message);
  const saved = data as { id: string; body: string; created_at: string };
  return { id: saved.id, username, body: saved.body, createdAt: saved.created_at, canDelete: true };
}

export async function deleteComment(
  accountId: string,
  rawKey: string,
  thesisId: string,
  commentId: string,
  client?: Db
): Promise<void> {
  const supabase = db(client);
  const row = await liveThesis(rawKey, thesisId, supabase);
  const { data, error } = await supabase
    .from('token_thesis_comments')
    .select('id, account_id, deleted_at')
    .eq('id', String(commentId))
    .eq('thesis_id', row.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const comment = data as { id: string; account_id: string; deleted_at: string | null } | null;
  if (!comment || comment.deleted_at) throw new ClientError('That comment is not there any more.');
  if (String(comment.account_id) !== accountId && !(await isAdmin(accountId, supabase))) {
    throw new ClientError('You can only delete your own comment.');
  }
  const { error: delErr } = await supabase
    .from('token_thesis_comments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', comment.id);
  if (delErr) throw new Error(delErr.message);
}
