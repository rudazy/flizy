import { getSupabase } from './supabase.ts';
import { validateUsername } from './username.ts';
import type { SearchResult } from './searchIndex.ts';

/**
 * The live half of site search: what only the server knows. Places and help
 * answers are matched in the browser (lib/searchIndex.ts).
 *
 * Each source runs on its own clock and fails on its own: a slow explorer
 * leaves the NFT group empty instead of holding up every other result. Rows
 * carry what a result line shows and nothing else: no account or owner ids.
 * People are found only by an exact @username, never by a partial one, so
 * search cannot be used to list the people on Flizy.
 */

export type Db = ReturnType<typeof getSupabase>;

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 64;
const PER_GROUP = 5;
const SOURCE_TIMEOUT_MS = 3000;

export type SearchGroups = {
  tokens: SearchResult[];
  projects: SearchResult[];
  tasks: SearchResult[];
  nfts: SearchResult[];
  people: SearchResult[];
};

export type CollectionLookup = (q: string) => Promise<Array<{ name: string; address: string; verified: boolean }>>;

/** The query as searched, or null when it is too short or too long to search. */
export function checkedSearchQuery(raw: unknown): string | null {
  const q = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (q.length < SEARCH_MIN || q.length > SEARCH_MAX) return null;
  return q;
}

/**
 * A pattern for ilike that matches the text literally. PostgREST also reads
 * `*` as a wildcard, so it is removed along with escaping `%`, `_` and `\`.
 */
export function likePattern(q: string): string {
  const literal = q.replace(/\*/g, '').replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${literal}%`;
}

/** A source that took too long or failed counts as no results. */
async function settle<T>(work: Promise<T[]>): Promise<T[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T[]>((resolve) => {
        timer = setTimeout(() => resolve([]), SOURCE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const LISTED_TOKENS = [{ symbol: 'FLZ', name: 'Flizy', key: 'flz' }];

function tokens(q: string): SearchResult[] {
  const needle = q.toLowerCase().replace(/^\$/, '');
  return LISTED_TOKENS.filter((t) => t.symbol.toLowerCase().includes(needle) || t.name.toLowerCase().includes(needle)).map((t) => ({
    kind: 'token' as const,
    title: t.symbol,
    subtitle: `${t.name} · listed on GIWA`,
    href: `/dashboard/explore/tokens/${t.key}`,
  }));
}

async function projects(q: string, supabase: Db): Promise<SearchResult[]> {
  const pattern = likePattern(q.replace(/^project\//i, ''));
  // Two plain filters rather than one `or` string, so the text is never part
  // of a filter expression PostgREST has to parse.
  const [byName, byHandle] = await Promise.all([
    supabase.from('projects').select('handle, name').ilike('name', pattern).limit(PER_GROUP),
    supabase.from('projects').select('handle, name').ilike('handle', pattern).limit(PER_GROUP),
  ]);
  if (byName.error) throw new Error(byName.error.message);
  if (byHandle.error) throw new Error(byHandle.error.message);
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const row of [...(byName.data || []), ...(byHandle.data || [])] as Array<{ handle: string; name: string }>) {
    if (seen.has(row.handle)) continue;
    seen.add(row.handle);
    out.push({ kind: 'project', title: row.name, subtitle: `project/${row.handle}`, href: `/project/${encodeURIComponent(row.handle)}` });
  }
  return out.slice(0, PER_GROUP);
}

async function tasks(q: string, supabase: Db): Promise<SearchResult[]> {
  const ref = /^#?(\d{1,9})$/.exec(q);
  const query = supabase.from('tasks').select('ref, title, status, ends_at');
  const { data, error } = ref
    ? await query.eq('ref', Number(ref[1])).limit(1)
    : await query.ilike('title', likePattern(q)).order('created_at', { ascending: false }).limit(PER_GROUP);
  if (error) throw new Error(error.message);
  const now = Date.now();
  return ((data || []) as Array<{ ref: number; title: string; status: string; ends_at: string }>).map((t) => {
    const open = t.status === 'live' && new Date(t.ends_at).getTime() > now;
    return {
      kind: 'task' as const,
      title: t.title,
      subtitle: `#${t.ref} · ${open ? 'Live' : t.status === 'cancelled' ? 'Cancelled' : 'Ended'}`,
      href: `/tasks/${t.ref}`,
    };
  });
}

async function nfts(q: string, lookup: CollectionLookup): Promise<SearchResult[]> {
  const rows = await lookup(q);
  return rows.slice(0, PER_GROUP).map((c) => ({
    kind: 'nft' as const,
    title: c.name || 'Unnamed collection',
    subtitle: `${c.verified ? 'Verified · ' : ''}${c.address.slice(0, 6)}...${c.address.slice(-4)}`,
    href: `/dashboard/explore/nfts/${c.address}`,
  }));
}

/** Exactly one account, by its whole username, or nobody. */
async function people(q: string, supabase: Db): Promise<SearchResult[]> {
  const checked = validateUsername(q.replace(/^@/, ''));
  if (!checked.ok) return [];
  const { data, error } = await supabase.from('accounts').select('username').eq('username', checked.username).maybeSingle();
  if (error) throw new Error(error.message);
  const username = (data as { username?: string | null } | null)?.username;
  if (!username) return [];
  return [{ kind: 'person', title: `@${username}`, subtitle: `Pay @${username}`, href: `/pay/${encodeURIComponent(username)}` }];
}

export async function siteSearch(
  raw: string,
  deps: { client?: Db; collections?: CollectionLookup } = {}
): Promise<SearchGroups | null> {
  const q = checkedSearchQuery(raw);
  if (!q) return null;
  const supabase = deps.client ?? getSupabase();
  const lookup = deps.collections ?? defaultCollectionLookup;
  const [p, t, n, who] = await Promise.all([
    settle(projects(q, supabase)),
    settle(tasks(q, supabase)),
    settle(nfts(q, lookup)),
    settle(people(q, supabase)),
  ]);
  return { tokens: tokens(q), projects: p, tasks: t, nfts: n, people: who };
}

/** The explorer-backed collection search the NFT page already uses. Loaded only when needed. */
const defaultCollectionLookup: CollectionLookup = async (q) => {
  const [{ nftContext }, { verifiedCollection }] = await Promise.all([import('./nftApi.ts'), import('./listedNfts')]);
  const page = await nftContext().index.searchCollections(q, null);
  return page.items.map((c: { name?: string | null; address: string }) => ({
    name: String(c.name || ''),
    address: c.address,
    verified: verifiedCollection(c.address) != null,
  }));
};
