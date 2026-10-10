import { getSupabase } from './supabase.ts';
import { ClientError } from './apiError.ts';
import {
  validateUsername,
  isUsernameReserved,
  normalizeUsername,
  reservedKey,
  USERNAME_UNAVAILABLE,
} from './username.ts';

/**
 * The client, injectable.
 *
 * Every exported function takes an optional one as its last argument and falls
 * back to getSupabase(). The routes pass nothing; tests pass a fake. This is the
 * shape web/lib/channelBind.ts already uses, and the reason it can be tested at
 * all while web/lib/claimPayout.ts cannot: a module that reaches for its own
 * client has no seam, and the authorisation rules here are exactly the ones
 * worth pinning.
 */
export type Db = ReturnType<typeof getSupabase>;

function db(client?: Db): Db {
  return client ?? getSupabase();
}

/**
 * Every read and write for tasks, so the routes stay thin and the rules live in
 * one place rather than being re-derived per endpoint.
 *
 * The rule that matters most here: a task's state is derived from the clock, not
 * stored. `status` records only what a person decided. See the header of
 * supabase/migrations/20260925010000_tasks.sql for why there is no scheduler.
 */

export type TaskState = 'live' | 'review' | 'completed' | 'cancelled';

export type TaskRow = {
  id: string;
  ref: number;
  creator_account_id: string;
  project_id: string | null;
  title: string;
  description: string;
  reward_kind: string;
  reward_asset: string | null;
  reward_total: string | null;
  reward_display: string;
  winners_count: number;
  distribution: unknown;
  requires_x_identity: boolean;
  ends_at: string;
  status: string;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  xp_reward?: number | null;
  category?: string | null;
  level?: string | null;
  featured_at?: string | null;
};

/**
 * What a task is doing right now.
 *
 * `review` is not a stored status: it is a live task whose deadline has passed
 * and whose winners have not been published. Nothing has to run for a task to
 * enter it, so nothing can fail to run and leave a closed task still open.
 *
 * The boundary is stated rather than implied: a task whose `ends_at` is exactly
 * now is closed. The submission trigger uses `ends_at <= now()` and this uses
 * the same comparison, because a deadline that is open on the instant it falls
 * is a deadline two readers will disagree about.
 */
export function deriveTaskState(row: Pick<TaskRow, 'status' | 'ends_at'>, now = Date.now()): TaskState {
  if (row.status === 'completed') return 'completed';
  if (row.status === 'cancelled') return 'cancelled';

  // An unreadable deadline closes the task rather than opening it. Written as
  // "is it still open" rather than "has it closed" on purpose: `NaN <= now` is
  // false, so the obvious phrasing left a corrupt row accepting entries for
  // ever. The column is not null, so this should be unreachable; unreachable is
  // not a reason to fail the dangerous way.
  const endsAt = new Date(row.ends_at).getTime();
  const stillOpen = Number.isFinite(endsAt) && endsAt > now;
  return stillOpen ? 'live' : 'review';
}

/** Whether a task is still taking entries. One question, one answer. */
export function isAcceptingEntries(row: Pick<TaskRow, 'status' | 'ends_at'>, now = Date.now()): boolean {
  return deriveTaskState(row, now) === 'live';
}

const X_POST_URL = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:[/?#]|$)/;

/**
 * Pull the handle and post id out of an X post URL, or null.
 *
 * Deliberately strict, and deliberately not a general URL parser: this value
 * arrives from a form and is stored, shown to other people and compared for
 * uniqueness. Anything that is not recognisably one post is refused rather than
 * normalised into something that looks valid.
 */
export function parseXPostUrl(raw: unknown): { handle: string; postId: string; canonical: string } | null {
  const value = String(raw ?? '').trim();
  const m = X_POST_URL.exec(value);
  if (!m) return null;
  const handle = m[1];
  const postId = m[2];
  // Stored canonically so two spellings of one post cannot both be entered. The
  // unique index lowercases as well, which covers the host and the handle.
  return { handle, postId, canonical: `https://x.com/${handle}/status/${postId}` };
}

const TASK_SELECT =
  'id, ref, creator_account_id, project_id, title, description, reward_kind, reward_asset, reward_total, reward_display, winners_count, distribution, requires_x_identity, ends_at, status, completed_at, cancelled_at, created_at, xp_reward, category, level, featured_at';

export const TASK_CATEGORIES = ['social', 'onchain', 'community', 'content'] as const;
export const TASK_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];
export type TaskLevel = (typeof TASK_LEVELS)[number];

/** The longest description a list row carries; the task page has the full text. */
const LIST_DESCRIPTION_MAX = 140;

export type TaskListItem = {
  ref: number;
  title: string;
  /** The start of the description, for one line on a list row. */
  description: string;
  category: TaskCategory | null;
  level: TaskLevel | null;
  rewardDisplay: string;
  winnersCount: number;
  participants: number;
  endsAt: string;
  state: TaskState;
  /** XP each winner earns. Project tasks only; null when the task carries none. */
  xpReward: number | null;
  /** verified: a project Flizy has verified. Always false for a personal creator. */
  creator: { kind: 'project' | 'personal'; name: string; handle: string | null; verified: boolean };
  /** A Flizy admin featured it. Featured tasks list first. */
  featured: boolean;
  /** What a participant does, in order: the reference links, then the one requirement. */
  steps: TaskStep[];
  /** The viewer saved it. Always false with no viewer. */
  saved: boolean;
};

/**
 * One step on a task card. `open` is a reference link the creator added; `submit`
 * is the requirement, which is always last because it is what gets judged.
 */
export type TaskStep =
  | { kind: 'open'; label: string; url: string }
  | { kind: 'submit'; label: string; requirement: string };

/**
 * The discovery list. Counts only, no submission contents: the Live page is for
 * deciding whether to open something, and showing entries there would let people
 * copy each other while the task is still running.
 */
export async function listTasks(
  opts: { state?: 'live' | 'ended'; viewerAccountId?: string | null } = {},
  client?: Db
): Promise<TaskListItem[]> {
  const supabase = db(client);
  const wanted = opts.state ?? 'live';
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  /*
   * Filtered and bounded in the database, not in JavaScript.
   *
   * This read every task row on every call to an endpoint that needs no session
   * and then filtered in memory. With nothing published that costs nothing, and
   * it stays free right up until it is not: the page it serves is the one meant
   * to be shared, so the first popular task is also the first time the query is
   * large and the first time a lot of people ask for it at once.
   *
   * "Ended" is two conditions rather than one, because a task is finished
   * either by a decision or by the clock, and PostgREST cannot express that as
   * a single filter without an `or` the test fake treats as a no-op. Two
   * bounded reads are clearer than one clever one.
   */
  let rows: TaskRow[];
  if (wanted === 'live') {
    const { data, error } = await supabase
      .from('tasks')
      .select(TASK_SELECT)
      .eq('status', 'live')
      .gt('ends_at', nowIso)
      // Soonest to close first, which is also the order somebody wants to see.
      .order('ends_at', { ascending: true })
      .limit(LIST_LIMIT);
    if (error) throw new Error(error.message);
    rows = (data || []) as TaskRow[];
  } else {
    const [decided, expired] = await Promise.all([
      supabase
        .from('tasks')
        .select(TASK_SELECT)
        .in('status', ['completed', 'cancelled'])
        .order('ends_at', { ascending: false })
        .limit(LIST_LIMIT),
      supabase
        .from('tasks')
        .select(TASK_SELECT)
        .eq('status', 'live')
        .lte('ends_at', nowIso)
        .order('ends_at', { ascending: false })
        .limit(LIST_LIMIT),
    ]);
    if (decided.error) throw new Error(decided.error.message);
    if (expired.error) throw new Error(expired.error.message);
    rows = [...((decided.data || []) as TaskRow[]), ...((expired.data || []) as TaskRow[])];
  }

  // The filter is still applied, so a row that does not belong cannot slip
  // through if a query above is ever changed and the two disagree.
  const picked = rows
    .filter((r) => {
      const state = deriveTaskState(r, now);
      return wanted === 'live' ? state === 'live' : state !== 'live';
    })
    .sort((a, b) =>
      wanted === 'live'
        ? new Date(a.ends_at).getTime() - new Date(b.ends_at).getTime()
        : new Date(b.ends_at).getTime() - new Date(a.ends_at).getTime()
    )
    .slice(0, LIST_LIMIT);

  // Featured first. Array sort is stable, so each group keeps the deadline order above.
  picked.sort((a, b) => Number(Boolean(b.featured_at)) - Number(Boolean(a.featured_at)));

  return toListItems(picked, opts.viewerAccountId ?? null, client);
}

const LIST_LIMIT = 60;

const PERSONAL_FALLBACK: TaskListItem['creator'] = { kind: 'personal', name: 'Flizy', handle: null, verified: false };

/**
 * Task rows as list items: counts, creator labels, steps and the viewer's saves,
 * each read once for the whole batch rather than once per task.
 */
async function toListItems(
  rows: TaskRow[],
  viewerAccountId: string | null,
  client?: Db,
  fallbackCreator: TaskListItem['creator'] = PERSONAL_FALLBACK
): Promise<TaskListItem[]> {
  if (!rows.length) return [];
  const now = Date.now();
  const ids = rows.map((r) => r.id);
  const [counts, creators, steps, saved] = await Promise.all([
    participantCounts(ids, client),
    creatorLabels(rows, client),
    stepsFor(ids, client),
    savedTaskIds(viewerAccountId, ids, client),
  ]);

  return rows.map((r) => ({
    ref: r.ref,
    title: r.title,
    ...listLabelsOf(r),
    rewardDisplay: r.reward_display,
    winnersCount: r.winners_count,
    participants: counts.get(r.id) || 0,
    endsAt: r.ends_at,
    state: deriveTaskState(r, now),
    xpReward: xpRewardOf(r),
    creator: creators.get(r.id) || fallbackCreator,
    featured: Boolean(r.featured_at),
    steps: steps.get(r.id) || [],
    saved: saved.has(r.id),
  }));
}

type StepRow = { task_id: string; kind: string; label: string; position?: number | null };

/**
 * Each task's steps: reference links in the creator's order, then the
 * requirement. Two reads for the whole batch, whatever its size.
 */
async function stepsFor(taskIds: string[], client?: Db): Promise<Map<string, TaskStep[]>> {
  const out = new Map<string, TaskStep[]>();
  if (!taskIds.length) return out;
  const supabase = db(client);
  const [reqs, links] = await Promise.all([
    supabase.from('task_requirements').select('task_id, kind, label, position').in('task_id', taskIds),
    supabase.from('task_links').select('task_id, kind, label, url, position').in('task_id', taskIds),
  ]);
  if (reqs.error) throw new Error(reqs.error.message);
  if (links.error) throw new Error(links.error.message);

  const byPosition = (a: { position?: number | null }, b: { position?: number | null }) =>
    Number(a.position ?? 0) - Number(b.position ?? 0);

  for (const l of ((links.data || []) as Array<StepRow & { url: string }>).sort(byPosition)) {
    // Stored links are https only, since createTask refuses anything else. A row
    // that is not is skipped rather than turned into a link on a public card.
    if (!/^https:\/\//i.test(String(l.url || ''))) continue;
    const list = out.get(String(l.task_id)) || [];
    list.push({ kind: 'open', label: String(l.label || 'Open link'), url: String(l.url) });
    out.set(String(l.task_id), list);
  }
  for (const r of ((reqs.data || []) as StepRow[]).sort(byPosition)) {
    const list = out.get(String(r.task_id)) || [];
    list.push({ kind: 'submit', label: String(r.label || 'Submit your entry'), requirement: String(r.kind) });
    out.set(String(r.task_id), list);
  }
  return out;
}

/** Which of these tasks the viewer saved. Empty with no viewer. */
async function savedTaskIds(viewerAccountId: string | null, taskIds: string[], client?: Db): Promise<Set<string>> {
  if (!viewerAccountId || !taskIds.length) return new Set();
  const { data, error } = await db(client)
    .from('task_saves')
    .select('task_id')
    .eq('account_id', viewerAccountId)
    .in('task_id', taskIds);
  if (error) throw new Error(error.message);
  return new Set(((data || []) as Array<{ task_id: string }>).map((r) => String(r.task_id)));
}

/** The label fields a list row shows. An unknown stored value is dropped rather than shown. */
function listLabelsOf(row: TaskRow): Pick<TaskListItem, 'description' | 'category' | 'level'> {
  const category = TASK_CATEGORIES.find((c) => c === row.category) ?? null;
  const level = TASK_LEVELS.find((l) => l === row.level) ?? null;
  return { description: String(row.description || '').slice(0, LIST_DESCRIPTION_MAX), category, level };
}

function xpRewardOf(row: Pick<TaskRow, 'xp_reward'>): number | null {
  const xp = Number(row.xp_reward);
  return Number.isInteger(xp) && xp > 0 ? xp : null;
}

/**
 * How many people entered each task.
 *
 * Counted in Postgres by task_participant_counts (a `group by task_id` over the
 * given ids), so this returns one row per task however many entries there are.
 * PostgREST cannot aggregate on its own, and reading one row per entry on a
 * public endpoint would make the cost of the page grow with its popularity.
 */
async function participantCounts(taskIds: string[], client?: Db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!taskIds.length) return out;
  const supabase = db(client);
  const { data, error } = await supabase.rpc('task_participant_counts', { p_task_ids: taskIds });
  if (error) throw new Error(error.message);

  for (const row of (data || []) as Array<{ task_id: string; participants: number | string }>) {
    out.set(String(row.task_id), Number(row.participants) || 0);
  }
  return out;
}

/** Who a task is shown as: the project when there is one, else the username. */
async function creatorLabels(
  rows: TaskRow[],
  client?: Db
): Promise<Map<string, TaskListItem['creator']>> {
  const supabase = db(client);
  const out = new Map<string, TaskListItem['creator']>();

  const projectIds = [...new Set(rows.map((r) => r.project_id).filter(Boolean))] as string[];
  const accountIds = [...new Set(rows.filter((r) => !r.project_id).map((r) => r.creator_account_id))];

  const projects = new Map<string, { name: string; handle: string; verified: boolean }>();
  if (projectIds.length) {
    // A failed lookup must not fall through to the personal branch below: that
    // would label a project's task with the @username of the account behind it.
    const { data, error } = await supabase
      .from('projects')
      .select('id, name, handle, verified_at')
      .in('id', projectIds);
    if (error) throw new Error(error.message);
    for (const p of data || []) {
      const row = p as { id: string; name: string; handle: string; verified_at?: string | null };
      projects.set(row.id, { name: row.name, handle: row.handle, verified: Boolean(row.verified_at) });
    }
  }

  const accounts = new Map<string, string>();
  if (accountIds.length) {
    const { data } = await supabase.from('accounts').select('id, username').in('id', accountIds);
    for (const a of data || []) {
      const row = a as { id: string; username: string | null };
      accounts.set(row.id, row.username || 'someone');
    }
  }

  for (const r of rows) {
    if (r.project_id && projects.has(r.project_id)) {
      const p = projects.get(r.project_id)!;
      out.set(r.id, { kind: 'project', name: p.name, handle: p.handle, verified: p.verified });
    } else {
      const username = accounts.get(r.creator_account_id) || 'someone';
      out.set(r.id, { kind: 'personal', name: `@${username}`, handle: username, verified: false });
    }
  }
  return out;
}

export type TaskDetail = {
  ref: number;
  title: string;
  description: string;
  rewardKind: string;
  rewardDisplay: string;
  rewardSecured: boolean;
  winnersCount: number;
  distribution: unknown;
  participants: number;
  endsAt: string;
  state: TaskState;
  requiresXIdentity: boolean;
  xpReward: number | null;
  creator: TaskListItem['creator'];
  isCreator: boolean;
  requirements: Array<{ id: string; kind: string; label: string }>;
  links: Array<{ kind: string; label: string; url: string }>;
  viewerHasEntered: boolean;
  winners: Array<{ place: number; username: string; submissionRef: number; url: string | null; rewardNote: string }>;
  category: TaskCategory | null;
  level: TaskLevel | null;
  featured: boolean;
  /** The viewer saved it. Always false with no viewer. */
  saved: boolean;
  /** The viewer is a Flizy admin, so the page offers Feature. Never shown to anyone else. */
  viewerIsAdmin: boolean;
};

/**
 * One task, for the public page.
 *
 * Submissions are never included while a task is live or under review. They
 * become visible only as the winner list once the creator has published it,
 * which is the permanent record of what actually won.
 */
export async function getTaskByRef(
  ref: number,
  opts: { viewerAccountId?: string | null } = {},
  client?: Db
): Promise<TaskDetail | null> {
  const supabase = db(client);
  const { data, error } = await supabase.from('tasks').select(TASK_SELECT).eq('ref', ref).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const task = data as TaskRow;
  const state = deriveTaskState(task);
  const viewer = opts.viewerAccountId || null;

  const [counts, creators, reqs, links, entered, winners, saved, viewerIsAdmin] = await Promise.all([
    participantCounts([task.id], client),
    creatorLabels([task], client),
    supabase
      .from('task_requirements')
      .select('id, kind, label')
      .eq('task_id', task.id)
      .order('position', { ascending: true }),
    supabase
      .from('task_links')
      .select('kind, label, url')
      .eq('task_id', task.id)
      .order('position', { ascending: true }),
    viewer
      ? supabase
          .from('task_submissions')
          .select('id')
          .eq('task_id', task.id)
          .eq('account_id', viewer)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    state === 'completed' ? loadWinners(task.id, client) : Promise.resolve([]),
    savedTaskIds(viewer, [task.id], client),
    viewer ? isAdminAccount(viewer, supabase) : Promise.resolve(false),
  ]);
  const labels = listLabelsOf(task);

  return {
    ref: task.ref,
    title: task.title,
    description: task.description,
    rewardKind: task.reward_kind,
    rewardDisplay: task.reward_display,
    // Honest by construction: nothing is held yet, so nothing claims to be. The
    // escrow work is what earns a true here.
    rewardSecured: false,
    winnersCount: task.winners_count,
    distribution: task.distribution,
    participants: counts.get(task.id) || 0,
    endsAt: task.ends_at,
    state,
    requiresXIdentity: task.requires_x_identity,
    xpReward: xpRewardOf(task),
    creator: creators.get(task.id) || { kind: 'personal', name: 'Flizy', handle: null, verified: false },
    isCreator: Boolean(viewer && viewer === task.creator_account_id),
    requirements: ((reqs as { data: unknown[] }).data || []) as TaskDetail['requirements'],
    links: ((links as { data: unknown[] }).data || []) as TaskDetail['links'],
    viewerHasEntered: Boolean((entered as { data: unknown }).data),
    winners,
    category: labels.category,
    level: labels.level,
    featured: Boolean(task.featured_at),
    saved: saved.has(task.id),
    viewerIsAdmin,
  };
}

async function loadWinners(taskId: string, client?: Db): Promise<TaskDetail['winners']> {
  const supabase = db(client);
  const { data, error } = await supabase
    .from('task_winners')
    .select('place, reward_note, account_id, submission_id')
    .eq('task_id', taskId)
    .order('place', { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (data || []) as Array<{
    place: number;
    reward_note: string;
    account_id: string;
    submission_id: string;
  }>;
  if (!rows.length) return [];

  const [{ data: accounts }, { data: subs }] = await Promise.all([
    supabase.from('accounts').select('id, username').in('id', rows.map((r) => r.account_id)),
    supabase.from('task_submissions').select('id, ref, content_url').in('id', rows.map((r) => r.submission_id)),
  ]);

  const nameOf = new Map((accounts || []).map((a) => [String((a as { id: string }).id), (a as { username: string | null }).username || 'someone']));
  const subOf = new Map(
    (subs || []).map((s) => [String((s as { id: string }).id), s as { ref: number; content_url: string | null }])
  );

  return rows.map((r) => ({
    place: r.place,
    username: nameOf.get(r.account_id) || 'someone',
    submissionRef: subOf.get(r.submission_id)?.ref ?? 0,
    url: subOf.get(r.submission_id)?.content_url ?? null,
    rewardNote: r.reward_note,
  }));
}

/** Loads a task by ref and refuses unless the caller owns it. */
async function requireOwnTask(ref: number, accountId: string, client?: Db): Promise<TaskRow> {
  const supabase = db(client);
  const { data, error } = await supabase.from('tasks').select(TASK_SELECT).eq('ref', ref).maybeSingle();
  if (error) throw new Error(error.message);
  // One message for "does not exist" and "not yours", so the ref is not an
  // oracle for which tasks exist while they are unlisted.
  if (!data || (data as TaskRow).creator_account_id !== accountId) {
    throw new ClientError('Task not found.');
  }
  return data as TaskRow;
}

export type CreateTaskInput = {
  title: string;
  description: string;
  rewardKind: string;
  rewardDisplay: string;
  rewardAsset?: string | null;
  rewardTotal?: string | null;
  winnersCount: number;
  distribution?: Array<{ place: number; amount: string }>;
  endsAt: string;
  projectId?: string | null;
  /** XP each winner earns. Only on a project task. */
  xpReward?: number | null;
  category?: string | null;
  level?: string | null;
  requirements: Array<{ kind: string; label: string }>;
  links?: Array<{ kind: string; label: string; url: string }>;
};

const REWARD_KINDS = new Set(['crypto', 'wl', 'nft', 'token', 'product', 'custom']);
const REQUIREMENT_KINDS = new Set(['x_post', 'link', 'text']);
const LINK_KINDS = new Set(['website', 'docs', 'x', 'custom']);
const PROJECT_LINK_KINDS = new Set(['website', 'x', 'telegram', 'docs', 'github', 'custom']);

/*
 * Per-account ceilings. Creation is open to every account, so these are what
 * stop one account from filling the public pages or flooding a task.
 *
 * They are counts over existing rows, not locks: two requests landing at the
 * same instant can both pass, so a ceiling can be overshot by the number of
 * requests in flight. That bounds a nuisance; it is not an authorisation rule.
 */
export const MAX_PROJECTS_PER_ACCOUNT = 5;
/** Personal tasks only. A project task counts against its project instead. */
export const MAX_LIVE_TASKS_PER_ACCOUNT = 10;
/**
 * Live tasks one project may have at once. Unlike the ceilings above this one
 * is also held by the tasks_project_live_cap trigger, under a lock on the
 * project row, because several members can publish for one project.
 */
export const MAX_LIVE_TASKS_PER_PROJECT = 5;
export const MAX_MEMBERS_PER_PROJECT = 20;
/** Projects one account can be a member of. Bounds its list and what others can put on it. */
export const MAX_PROJECTS_JOINED_PER_ACCOUNT = 10;
export const MAX_TASK_XP = 100000;
const PROJECT_LIVE_CAP_ERROR = `This project has ${MAX_LIVE_TASKS_PER_PROJECT} live tasks. Publish more when one ends.`;
export const MAX_TASKS_PER_ACCOUNT_PER_DAY = 10;
export const MAX_SUBMISSIONS_PER_ACCOUNT_PER_HOUR = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The same ceiling the task_winners_reward_note_len constraint holds. */
export const REWARD_NOTE_MAX = 120;

/** The review list is capped; entries past it are not returned. */
const REVIEW_LIST_LIMIT = 500;

/** Normalised the way reservedKey is, so spacing, case and doubled letters do not dodge it. */
const BRAND_KEY = 'flizy';
const BRAND_NAME_ERROR = 'Names and titles cannot use the Flizy name.';

async function isAdminAccount(accountId: string, supabase: Db): Promise<boolean> {
  const { data, error } = await supabase.from('accounts').select('is_admin').eq('id', accountId).maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data && (data as { is_admin?: boolean | null }).is_admin === true);
}

/**
 * Refuse a public name that carries the product's own name, unless an admin is
 * publishing it. A project called "Flizy Rewards" or a task titled "Official
 * Flizy airdrop" would read as the product speaking.
 */
async function refuseBrandName(accountId: string, values: string[], supabase: Db) {
  if (!values.some((v) => reservedKey(v).includes(BRAND_KEY))) return;
  if (await isAdminAccount(accountId, supabase)) return;
  throw new ClientError(BRAND_NAME_ERROR);
}

/**
 * Whether a project handle is held by public.reserved_usernames for this
 * account. The brand entries ("flizy", "flizybot", ...) keep the name from
 * ordinary accounts; for a project handle the brand rule above already does
 * that, and an admin is the one account allowed to publish as Flizy. Every
 * other reserved name (admin, support, ...) stays refused for everyone.
 */
async function isProjectHandleReserved(handle: string, accountId: string, supabase: Db): Promise<boolean> {
  if (!(await isUsernameReserved(supabase, handle))) return false;
  if (!reservedKey(handle).includes(BRAND_KEY)) return true;
  return !(await isAdminAccount(accountId, supabase));
}

export type ProjectRole = 'owner' | 'member';

/**
 * The caller's standing on a project: its owner, a member the owner added, or
 * nothing. Owner and member may publish tasks for it and edit its details;
 * only the owner manages members.
 */
async function projectAccess(accountId: string, projectId: string, supabase: Db): Promise<ProjectRole | null> {
  const { data: project, error } = await supabase
    .from('projects')
    .select('id, owner_account_id')
    .eq('id', projectId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!project) return null;
  if (String((project as { owner_account_id: string }).owner_account_id) === accountId) return 'owner';

  const { data: member, error: memberErr } = await supabase
    .from('project_members')
    .select('id')
    .eq('project_id', projectId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (memberErr) throw new Error(memberErr.message);
  return member ? 'member' : null;
}

/** A label is optional; when given it must be one of the listed values. */
function checkedLabel<T extends string>(raw: unknown, allowed: readonly T[], message: string): T | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = allowed.find((a) => a === String(raw));
  if (!value) throw new ClientError(message);
  return value;
}

/** XP is a whole number, set only on a project task. Absent or empty means none. */
function checkedXpReward(raw: unknown, projectId: string | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const xp = Number(raw);
  if (!Number.isInteger(xp) || xp < 1 || xp > MAX_TASK_XP) {
    throw new ClientError(`XP must be a whole number from 1 to ${MAX_TASK_XP}.`);
  }
  if (!projectId) throw new ClientError('XP can only be set on a project task.');
  return xp;
}

async function countRows(
  query: PromiseLike<{ count: number | null; error: { message: string } | null }>
): Promise<number> {
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count || 0;
}

export async function createTask(accountId: string, input: CreateTaskInput, client?: Db) {
  const title = String(input.title || '').trim();
  if (title.length < 3 || title.length > 140) throw new ClientError('Title must be 3 to 140 characters.');

  const rewardKind = String(input.rewardKind || '');
  if (!REWARD_KINDS.has(rewardKind)) throw new ClientError('Pick a reward type.');

  const rewardDisplay = String(input.rewardDisplay || '').trim();
  if (!rewardDisplay) throw new ClientError('Say what the reward is.');
  if (rewardDisplay.length > 120) throw new ClientError('Keep the reward line short.');

  /*
   * Everything below is bounded, and the bounds are the point.
   *
   * Any account may publish, and what it publishes is served on a page anyone
   * can open, so no field is taken as given. The same limits are CHECK
   * constraints in the tasks migration, so a writer that skips this function
   * is refused by the database instead.
   */
  const description = String(input.description || '').trim();
  if (description.length > 8000) throw new ClientError('Description is too long.');

  const winnersCount = Number(input.winnersCount);
  if (!Number.isInteger(winnersCount) || winnersCount < 1 || winnersCount > 100) {
    throw new ClientError('Winners must be a whole number from 1 to 100.');
  }

  const endsAtMs = new Date(String(input.endsAt || '')).getTime();
  if (!Number.isFinite(endsAtMs)) throw new ClientError('Give a valid end date.');
  if (endsAtMs <= Date.now()) throw new ClientError('The end date must be in the future.');

  const requirements = (input.requirements || []).filter((r) => r && r.kind);
  if (!requirements.length) throw new ClientError('Add at least one requirement.');
  // Exactly one. The submit form asks for what the first requirement needs and
  // submitToTask checks against the same one, so a second could never be met.
  if (requirements.length > 1) throw new ClientError('That is too many requirements: a task takes exactly one.');
  for (const r of requirements) {
    if (!REQUIREMENT_KINDS.has(String(r.kind))) throw new ClientError('Unsupported requirement type.');
    if (String(r.label || '').length > 200) throw new ClientError('Keep each requirement short.');
  }

  const links = (input.links || []).filter((l) => l && l.url);
  // The same ceiling addTaskLink already enforces. It had one and this did not,
  // so the limit could be walked around by putting the links in at creation.
  if (links.length > 20) throw new ClientError('That is too many links.');
  for (const l of links) {
    if (!LINK_KINDS.has(String(l.kind || 'custom'))) throw new ClientError('Unsupported link type.');
    if (!/^https:\/\//i.test(String(l.url))) throw new ClientError('Links must start with https.');
    if (String(l.url).length > 2000) throw new ClientError('That link is too long.');
    if (String(l.label || '').length > 80) throw new ClientError('Keep each link label short.');
  }

  /*
   * The distribution is shown to entrants as what each place pays, so it is
   * checked rather than passed through. It was stored as whatever JSON arrived:
   * any shape, any depth, any size, straight onto a public page.
   */
  const distribution = (Array.isArray(input.distribution) ? input.distribution : [])
    .slice(0, winnersCount)
    .map((d) => ({
      place: Number((d as { place?: unknown })?.place) || 0,
      amount: String((d as { amount?: unknown })?.amount ?? '').slice(0, 40),
    }))
    .filter((d) => d.place >= 1 && d.place <= winnersCount);

  const supabase = db(client);

  // A project may only be used by its owner or a member. Without this an id
  // guessed from another account would let anyone publish under its name.
  let projectId: string | null = null;
  if (input.projectId) {
    const access = await projectAccess(accountId, String(input.projectId), supabase);
    if (!access) throw new ClientError('That project is not yours.');
    projectId = String(input.projectId);
  }

  const xpReward = checkedXpReward(input.xpReward, projectId);
  const category = checkedLabel(input.category, TASK_CATEGORIES, 'Pick a category from the list.');
  const level = checkedLabel(input.level, TASK_LEVELS, 'Pick a level from the list.');

  await refuseBrandName(accountId, [title], supabase);

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  if (projectId) {
    const projectLive = await countRows(
      supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('status', 'live')
        .gt('ends_at', nowIso)
    );
    if (projectLive >= MAX_LIVE_TASKS_PER_PROJECT) throw new ClientError(PROJECT_LIVE_CAP_ERROR);
  } else {
    const live = await countRows(
      supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('creator_account_id', accountId)
        .is('project_id', null)
        .eq('status', 'live')
        .gt('ends_at', nowIso)
    );
    if (live >= MAX_LIVE_TASKS_PER_ACCOUNT) {
      throw new ClientError(`You can have ${MAX_LIVE_TASKS_PER_ACCOUNT} live tasks at once.`);
    }
  }
  const lastDay = await countRows(
    supabase
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('creator_account_id', accountId)
      .gte('created_at', new Date(nowMs - DAY_MS).toISOString())
  );
  if (lastDay >= MAX_TASKS_PER_ACCOUNT_PER_DAY) {
    throw new ClientError(`You can publish ${MAX_TASKS_PER_ACCOUNT_PER_DAY} tasks a day. Try again later.`);
  }

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      creator_account_id: accountId,
      project_id: projectId,
      title,
      description,
      reward_kind: rewardKind,
      reward_asset: input.rewardAsset ? String(input.rewardAsset).trim().slice(0, 40) : null,
      reward_total: input.rewardTotal ? String(input.rewardTotal) : null,
      reward_display: rewardDisplay,
      winners_count: winnersCount,
      distribution,
      ends_at: new Date(endsAtMs).toISOString(),
      status: 'live',
      xp_reward: xpReward,
      category,
      level,
    })
    .select('id, ref')
    .single();
  if (error) {
    // tasks_project_live_cap is the authority on the per-project ceiling.
    if (error.code === 'FZ102') throw new ClientError(PROJECT_LIVE_CAP_ERROR);
    throw new Error(error.message);
  }
  const task = data as { id: string; ref: number };

  /*
   * Three writes, not one transaction, so a failure after the first removes the
   * task again. A live task with no requirement would take entries nobody can
   * judge. Requirements and links reference the task with on delete cascade,
   * so deleting the task row removes whatever of them did land.
   */
  try {
    const { error: reqErr } = await supabase.from('task_requirements').insert(
      requirements.map((r, i) => ({
        task_id: task.id,
        position: i,
        kind: String(r.kind),
        label: String(r.label || '').trim() || String(r.kind),
      }))
    );
    if (reqErr) throw new Error(reqErr.message);

    if (links.length) {
      const { error: linkErr } = await supabase.from('task_links').insert(
        links.map((l, i) => ({
          task_id: task.id,
          position: i,
          kind: String(l.kind || 'custom'),
          label: String(l.label || '').trim() || String(l.kind || 'link'),
          url: String(l.url).trim(),
        }))
      );
      if (linkErr) throw new Error(linkErr.message);
    }
  } catch (err) {
    const { error: undoErr } = await supabase.from('tasks').delete().eq('id', task.id);
    if (undoErr) {
      console.error(
        `[tasks] task #${task.ref} failed to publish and could not be removed: ${undoErr.message}`
      );
    }
    throw err;
  }

  return { ref: task.ref };
}

/*
 * There is deliberately no addTaskLink here.
 *
 * One was written, so a creator could keep adding references after publishing,
 * and nothing ever called it: no route, no button. An exported writer with no
 * caller is not harmless. It is a function that has never run against the real
 * database, carries its own copy of the link rules, and is sitting there for the
 * next feature to reach for. That is exactly how lib/trusted.js ended up with an
 * addTrusted the chat surface could import.
 *
 * Links are set when a task is published. When there is a screen that needs to
 * add one later, it arrives with its route and its test.
 */

export type SubmitResult = { submissionRef: number; verification: 'x_verified' | 'unverified' };

/**
 * Enter a task.
 *
 * The deadline is checked here for a decent message and again by a database
 * trigger, which is the one that actually decides. The unique indexes do the
 * same for the two duplicate cases, so a race between two submissions cannot
 * produce two entries.
 */
export async function submitToTask(
  accountId: string,
  ref: number,
  input: { url?: string; text?: string },
  client?: Db
): Promise<SubmitResult> {
  const supabase = db(client);
  const { data: taskRow, error: taskErr } = await supabase
    .from('tasks')
    .select(TASK_SELECT)
    .eq('ref', ref)
    .maybeSingle();
  if (taskErr) throw new Error(taskErr.message);
  if (!taskRow) throw new ClientError('Task not found.');
  const task = taskRow as TaskRow;

  if (!isAcceptingEntries(task)) throw new ClientError('This task is closed.');
  if (task.creator_account_id === accountId) {
    throw new ClientError('You cannot enter your own task.');
  }

  const { data: reqRows } = await supabase
    .from('task_requirements')
    .select('id, kind')
    .eq('task_id', task.id)
    .order('position', { ascending: true });
  const requirements = (reqRows || []) as Array<{ id: string; kind: string }>;
  // The first requirement, which is the one TaskSubmitForm asks for. createTask
  // allows exactly one, so the form and this check cannot disagree.
  const wantsXPost = requirements[0]?.kind === 'x_post';

  let contentUrl: string | null = null;
  let contentText: string | null = null;
  let verification: 'x_verified' | 'unverified' = 'unverified';
  let xExternalId: string | null = null;

  if (wantsXPost) {
    const parsed = parseXPostUrl(input.url);
    if (!parsed) throw new ClientError('Paste the link to your X post, like https://x.com/you/status/123.');
    contentUrl = parsed.canonical;

    const identity = await xIdentityFor(accountId, client);
    if (task.requires_x_identity && !identity) {
      throw new ClientError('Link your X account first, then submit.');
    }
    if (identity) {
      xExternalId = identity.externalId;
      if (
        identity.handle &&
        identity.handle.toLowerCase() === parsed.handle.toLowerCase()
      ) {
        verification = 'x_verified';
      }
    }
  } else if (input.url) {
    const url = String(input.url).trim();
    if (!/^https:\/\//i.test(url)) throw new ClientError('Links must start with https.');
    if (url.length > 2000) throw new ClientError('That link is too long.');
    contentUrl = url;
  } else {
    const text = String(input.text || '').trim();
    if (text.length < 2) throw new ClientError('Write your entry first.');
    if (text.length > 4000) throw new ClientError('That entry is too long.');
    contentText = text;
  }

  const recent = await countRows(
    supabase
      .from('task_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .gte('created_at', new Date(Date.now() - HOUR_MS).toISOString())
  );
  if (recent >= MAX_SUBMISSIONS_PER_ACCOUNT_PER_HOUR) {
    throw new ClientError('You have entered a lot of tasks in the last hour. Try again later.');
  }

  const { count } = await supabase
    .from('task_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('task_id', task.id);

  const { data, error } = await supabase
    .from('task_submissions')
    .insert({
      task_id: task.id,
      ref: (count || 0) + 1,
      account_id: accountId,
      requirement_id: requirements[0]?.id ?? null,
      content_url: contentUrl,
      content_text: contentText,
      verification,
      x_external_id: xExternalId,
    })
    .select('ref')
    .single();

  if (error) {
    // The database is the authority on all three of these, so its answer is
    // what gets translated rather than a second opinion computed here.
    if (error.code === '23505') {
      const message = String(error.message || '');
      if (message.includes('task_submissions_url_unique_idx')) {
        throw new ClientError('That post has already been submitted.');
      }
      if (message.includes('task_submissions_one_per_account')) {
        throw new ClientError('You have already entered this task.');
      }
      // A ref collision means two people entered at once. Theirs landed first.
      throw new ClientError('Someone submitted at the same moment. Try again.');
    }
    if (error.code === 'FZ100') throw new ClientError('This task is closed.');
    throw new Error(error.message);
  }

  return { submissionRef: (data as { ref: number }).ref, verification };
}

/** The participant's linked X identity, if they have one. */
async function xIdentityFor(
  accountId: string,
  client?: Db
): Promise<{ externalId: string; handle: string | null } | null> {
  const supabase = db(client);
  const { data } = await supabase
    .from('channel_identities')
    .select('external_id, display_handle')
    .eq('account_id', accountId)
    .eq('channel', 'x')
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const row = data as { external_id: string; display_handle: string | null };
  return { externalId: String(row.external_id), handle: row.display_handle };
}

export type CreatorSubmission = {
  id: string;
  ref: number;
  username: string;
  url: string | null;
  text: string | null;
  verification: string;
  createdAt: string;
};

/**
 * The review list, creator only, and only once the task has closed.
 *
 * Withheld while live for the same reason the public page withholds it: a
 * creator browsing entries mid-task is a channel for leaking them.
 *
 * Never returned for a cancelled task either. Cancelling ends a task without
 * picking anyone, so a creator could otherwise collect every entry and then
 * walk away from the reward.
 *
 * The first REVIEW_LIST_LIMIT entries by submission number are returned.
 */
export async function listSubmissionsForCreator(
  accountId: string,
  ref: number,
  client?: Db
): Promise<{ submissions: CreatorSubmission[]; winnersCount: number; state: TaskState }> {
  const task = await requireOwnTask(ref, accountId, client);
  const state = deriveTaskState(task);
  if (state === 'live') throw new ClientError('Entries can be reviewed once the task closes.');
  if (state === 'cancelled') throw new ClientError('This task was cancelled, so its entries stay private.');

  const supabase = db(client);
  const { data, error } = await supabase
    .from('task_submissions')
    .select('id, ref, account_id, content_url, content_text, verification, created_at')
    .eq('task_id', task.id)
    .order('ref', { ascending: true })
    .limit(REVIEW_LIST_LIMIT);
  if (error) throw new Error(error.message);

  const rows = (data || []) as Array<{
    id: string;
    ref: number;
    account_id: string;
    content_url: string | null;
    content_text: string | null;
    verification: string;
    created_at: string;
  }>;

  const { data: accounts } = rows.length
    ? await supabase.from('accounts').select('id, username').in('id', rows.map((r) => r.account_id))
    : { data: [] };
  const nameOf = new Map(
    (accounts || []).map((a) => [
      String((a as { id: string }).id),
      (a as { username: string | null }).username || 'someone',
    ])
  );

  return {
    state,
    winnersCount: task.winners_count,
    submissions: rows.map((r) => ({
      id: r.id,
      ref: r.ref,
      username: nameOf.get(r.account_id) || 'someone',
      url: r.content_url,
      text: r.content_text,
      verification: r.verification,
      createdAt: r.created_at,
    })),
  };
}

export type WinnerPick = { submissionId: string; place: number; rewardNote?: string };

/**
 * Publish the winners and complete the task, in that order.
 *
 * The completion is a conditional update guarded on the task still being live,
 * which is what stops two review sessions both publishing. The pattern is
 * lib/claims.js beginClaimProcessing: decide the winner of the race in the
 * database, then act, never the other way round.
 *
 * @returns the accounts to notify, so the route can do it after the write
 */
export async function finalizeWinners(
  accountId: string,
  ref: number,
  picks: WinnerPick[],
  client?: Db
): Promise<{ taskRef: number; notify: Array<{ accountId: string; place: number; submissionRef: number }> }> {
  const task = await requireOwnTask(ref, accountId, client);
  const state = deriveTaskState(task);
  if (state === 'live') throw new ClientError('Wait for the task to close.');
  if (state !== 'review') throw new ClientError('This task is already finished.');

  if (!Array.isArray(picks) || !picks.length) throw new ClientError('Pick at least one winner.');
  if (picks.length > task.winners_count) {
    throw new ClientError(`This task has ${task.winners_count} winner slots.`);
  }
  for (const p of picks) {
    const place = Number(p.place);
    if (!Number.isInteger(place) || place < 1 || place > task.winners_count) {
      throw new ClientError(`Places run from 1 to ${task.winners_count}.`);
    }
    if (String(p.rewardNote ?? '').trim().length > REWARD_NOTE_MAX) {
      throw new ClientError(`Keep each reward note to ${REWARD_NOTE_MAX} characters.`);
    }
  }
  const places = new Set(picks.map((p) => Number(p.place)));
  if (places.size !== picks.length) throw new ClientError('Two winners cannot share a place.');
  const entries = new Set(picks.map((p) => String(p.submissionId)));
  if (entries.size !== picks.length) throw new ClientError('One entry cannot win twice.');

  const supabase = db(client);
  const { data: subRows, error: subErr } = await supabase
    .from('task_submissions')
    .select('id, ref, account_id')
    .eq('task_id', task.id)
    .in('id', picks.map((p) => String(p.submissionId)));
  if (subErr) throw new Error(subErr.message);

  const subs = (subRows || []) as Array<{ id: string; ref: number; account_id: string }>;
  // Scoped to this task, so a submission id from another task cannot be pulled
  // in by guessing. Anything that did not come back was not eligible.
  if (subs.length !== picks.length) throw new ClientError('One of those entries is not in this task.');

  const byId = new Map(subs.map((s) => [s.id, s]));

  // Take the task first. A loser of this race writes nothing.
  const { data: taken, error: takeErr } = await supabase
    .from('tasks')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', task.id)
    .eq('status', 'live')
    .select('id');
  if (takeErr) throw new Error(takeErr.message);
  if (!taken || taken.length === 0) throw new ClientError('This task is already finished.');

  const { error: winErr } = await supabase.from('task_winners').insert(
    picks.map((p) => {
      const sub = byId.get(String(p.submissionId))!;
      return {
        task_id: task.id,
        submission_id: sub.id,
        account_id: sub.account_id,
        place: Number(p.place),
        reward_note: String(p.rewardNote || '').trim(),
        // Copied now, so editing the task later cannot change what was awarded.
        xp: xpRewardOf(task) ?? 0,
      };
    })
  );
  if (winErr) {
    // Put the task back rather than leaving it completed with no winners, which
    // would be a dead end for the creator and a lie on the public page. If that
    // fails too the task is in exactly that state, so it is logged and reported
    // as such rather than as the ordinary insert failure.
    const { error: undoErr } = await supabase
      .from('tasks')
      .update({ status: 'live', completed_at: null })
      .eq('id', task.id)
      .eq('status', 'completed');
    if (undoErr) {
      console.error(
        `[tasks] task #${task.ref} is completed with no winners: saving winners failed (${winErr.message}) and reopening it failed (${undoErr.message})`
      );
      throw new Error(`Task #${task.ref} is completed with no winners and could not be reopened.`);
    }
    throw new Error(winErr.message);
  }

  return {
    taskRef: task.ref,
    notify: picks.map((p) => {
      const sub = byId.get(String(p.submissionId))!;
      return { accountId: sub.account_id, place: Number(p.place), submissionRef: sub.ref };
    }),
  };
}

/** Mark winners told, so a retry cannot announce twice. */
export async function markWinnersNotified(taskRef: number, accountIds: string[], client?: Db) {
  if (!accountIds.length) return;
  const supabase = db(client);
  const { data: task } = await supabase.from('tasks').select('id').eq('ref', taskRef).maybeSingle();
  if (!task) return;
  await supabase
    .from('task_winners')
    .update({ notified_at: new Date().toISOString() })
    .eq('task_id', (task as { id: string }).id)
    .in('account_id', accountIds)
    .is('notified_at', null);
}

export async function cancelTask(accountId: string, ref: number, client?: Db) {
  const task = await requireOwnTask(ref, accountId, client);
  if (task.status !== 'live') throw new ClientError('This task is already finished.');

  const supabase = db(client);
  const { data, error } = await supabase
    .from('tasks')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', task.id)
    .eq('status', 'live')
    .select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new ClientError('This task is already finished.');
}

/**
 * Create a publishing identity.
 *
 * The handle borrows the username rules wholesale rather than inventing a second
 * set: same characters, same length, same reserved list. That is not tidiness. A
 * project reached at /project/admin would read as Flizy staff exactly as `@admin`
 * would, and the reserved list is where that judgement already lives.
 *
 * A handle and a username may not be the same name: createProject refuses a
 * username, isHandleTakenByProject serves the other direction, and triggers in
 * the tasks migration hold both. A handle cannot collide with /pay/[code],
 * which is a single path segment.
 */
export type ProjectLink = { kind: string; label: string; url: string };

export type OwnedProject = {
  id: string;
  handle: string;
  name: string;
  description: string;
  verified: boolean;
  /** The picture as a data URL, or null for the letter mark. */
  image: string | null;
};

/** A project the account owns or is a member of, with its task counts. */
export type OwnedProjectListItem = OwnedProject & {
  role: ProjectRole;
  activeTasks: number;
  totalTasks: number;
};

export type ProjectHandleCheck =
  | { available: true; handle: string }
  | { available: false; reason: string };

const PROJECT_LINK_LABEL: Record<string, string> = {
  website: 'Website',
  x: 'X',
  telegram: 'Telegram',
  docs: 'Documentation',
  github: 'GitHub',
  custom: 'Link',
};

/** Public links only. A bad entry is dropped rather than thrown onto the page. */
function projectLinksFrom(value: unknown): ProjectLink[] {
  if (!Array.isArray(value)) return [];
  const out: ProjectLink[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const kind = String((row as { kind?: unknown }).kind || 'custom');
    const url = String((row as { url?: unknown }).url || '').trim();
    const label = String((row as { label?: unknown }).label || '').trim();
    if (!PROJECT_LINK_KINDS.has(kind)) continue;
    if (!/^https:\/\//i.test(url)) continue;
    out.push({
      kind,
      url: url.slice(0, 2000),
      label: (label || PROJECT_LINK_LABEL[kind] || 'Link').slice(0, 80),
    });
    if (out.length >= 20) break;
  }
  return out;
}

export function checkedProjectLinks(input: ProjectLink[] | undefined): ProjectLink[] {
  const links = (input || []).filter((l) => l && l.url);
  if (links.length > 20) throw new ClientError('That is too many links.');
  return links.map((l) => {
    const kind = String(l.kind || 'custom');
    if (!PROJECT_LINK_KINDS.has(kind)) throw new ClientError('Unsupported link type.');
    const url = String(l.url || '').trim();
    if (!/^https:\/\//i.test(url)) throw new ClientError('Links must start with https.');
    if (url.length > 2000) throw new ClientError('That link is too long.');
    const label = String(l.label || '').trim() || PROJECT_LINK_LABEL[kind] || 'Link';
    if (label.length > 80) throw new ClientError('Keep each link label short.');
    return { kind, label, url };
  });
}

/** The same ceilings the projects_image_format and projects_banner_format constraints hold. */
export const PROJECT_IMAGE_MAX_CHARS = 200000;
export const PROJECT_BANNER_MAX_CHARS = 300000;
const PROJECT_IMAGE_DATA_URL = /^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

/** The first bytes each allowed format starts with, so a label cannot lie about the file. */
function imageBytesMatch(kind: string, bytes: Uint8Array): boolean {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (kind === 'png') return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (kind === 'jpeg') return starts([0xff, 0xd8, 0xff]);
  // RIFF....WEBP
  return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
}

/**
 * A project picture: a PNG, JPEG or WebP data URL the browser has already
 * shrunk. SVG is not accepted, since it can carry script. Undefined means
 * "not given"; null or an empty string means "no picture".
 */
export function checkedProjectImage(raw: unknown): string | null {
  return checkedImageDataUrl(raw, PROJECT_IMAGE_MAX_CHARS);
}

/** The hero banner: the same checks as the picture, with room for a wide image. */
export function checkedProjectBanner(raw: unknown): string | null {
  return checkedImageDataUrl(raw, PROJECT_BANNER_MAX_CHARS);
}

function checkedImageDataUrl(raw: unknown, maxChars: number): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw);
  if (value.length > maxChars) throw new ClientError('That picture is too large.');
  const m = PROJECT_IMAGE_DATA_URL.exec(value);
  if (!m) throw new ClientError('Use a PNG, JPEG or WebP picture.');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length < 12 || !imageBytesMatch(m[1], bytes)) throw new ClientError('That file is not a picture.');
  return value;
}

export async function createProject(
  accountId: string,
  input: {
    handle: string;
    name: string;
    description?: string;
    links?: ProjectLink[];
    image?: string | null;
    banner?: string | null;
  },
  client?: Db
): Promise<OwnedProject> {
  const checked = validateUsername(input.handle);
  if (!checked.ok) throw new ClientError(checked.error);
  const handle = checked.username;

  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 60) throw new ClientError('Project name must be 2 to 60 characters.');

  const description = String(input.description || '').trim();
  if (description.length > 800) throw new ClientError('Description is too long.');

  const links = checkedProjectLinks(input.links);
  const image = checkedProjectImage(input.image);
  const banner = checkedProjectBanner(input.banner);

  const supabase = db(client);
  if (await isProjectHandleReserved(handle, accountId, supabase)) throw new ClientError(USERNAME_UNAVAILABLE);

  // A handle that is somebody's username would make one name two identities.
  // The projects_handle_not_username trigger holds the same rule underneath.
  const { data: takenByAccount } = await supabase
    .from('accounts')
    .select('id')
    .eq('username', handle)
    .maybeSingle();
  if (takenByAccount) throw new ClientError(USERNAME_UNAVAILABLE);

  await refuseBrandName(accountId, [name, handle], supabase);

  const owned = await countRows(
    supabase
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('owner_account_id', accountId)
  );
  if (owned >= MAX_PROJECTS_PER_ACCOUNT) {
    throw new ClientError(`An account can have ${MAX_PROJECTS_PER_ACCOUNT} projects.`);
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({ owner_account_id: accountId, handle, name, description, links, image, banner })
    .select('id, handle, name, description, image')
    .single();
  if (error) {
    // The unique index and the username trigger (FZ101) are the authority;
    // this only translates them.
    if (error.code === '23505' || error.code === 'FZ101') throw new ClientError(USERNAME_UNAVAILABLE);
    throw new Error(error.message);
  }
  const row = data as OwnedProject;
  return {
    id: row.id,
    handle: row.handle,
    name: row.name,
    description: String(row.description || ''),
    verified: false,
    image: row.image || null,
  };
}

/**
 * Whether a project already holds this name as its handle.
 *
 * Usernames and project handles are one namespace, checked in both directions:
 * createProject refuses a username, and setting a username refuses a handle.
 * The accounts_username_not_project_handle trigger holds this side in the
 * database. Handles are stored normalised, so the name is normalised the same
 * way before comparing.
 */
export async function isHandleTakenByProject(name: string, client?: Db): Promise<boolean> {
  const handle = normalizeUsername(name);
  if (!handle) return false;
  const { data, error } = await db(client).from('projects').select('id').eq('handle', handle).maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

/**
 * Whether this handle can be saved on a new project.
 *
 * Same order as createProject, so the sentence shown while typing is the
 * sentence submit would use. Reserved, a username clash, and a handle another
 * project already has all share one sentence. The signed-in account's own
 * username is a clash here. The username picker treats that name as free.
 */
export async function projectHandleAvailable(
  raw: string,
  accountId: string,
  client?: Db
): Promise<ProjectHandleCheck> {
  const checked = validateUsername(raw);
  if (!checked.ok) return { available: false, reason: checked.error };
  const handle = checked.username;
  const supabase = db(client);

  if (await isProjectHandleReserved(handle, accountId, supabase)) {
    return { available: false, reason: USERNAME_UNAVAILABLE };
  }

  const { data: takenByAccount, error } = await supabase
    .from('accounts')
    .select('id')
    .eq('username', handle)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (takenByAccount) return { available: false, reason: USERNAME_UNAVAILABLE };

  // Before the "already a project" check, because createProject refuses the
  // brand name before insert. A taken handle that also carries the brand name
  // is told about the brand name.
  if (reservedKey(handle).includes(BRAND_KEY) && !(await isAdminAccount(accountId, supabase))) {
    return { available: false, reason: BRAND_NAME_ERROR };
  }

  if (await isHandleTakenByProject(handle, supabase)) {
    return { available: false, reason: USERNAME_UNAVAILABLE };
  }

  return { available: true, handle };
}

type ProjectRecord = {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  links: unknown;
  owner_account_id: string;
  verified_at?: string | null;
  image?: string | null;
  banner?: string | null;
  created_at?: string;
};

const PROJECT_SELECT = 'id, handle, name, description, links, owner_account_id, verified_at, image, created_at';
/** The page also needs the banner, which the project list leaves out to stay small. */
const PROJECT_PAGE_SELECT = `${PROJECT_SELECT}, banner`;

/**
 * The projects an account may publish as: the ones it owns, then the ones it
 * was added to. The owner id is not returned.
 *
 * activeTasks counts rows that are still open: status live, and a deadline
 * still ahead. That is the same answer deriveTaskState gives, because a
 * completed or cancelled row is never open and a live row whose deadline has
 * passed is not either. A count that fails leaves the projects in place.
 */
export async function listOwnProjects(accountId: string, client?: Db): Promise<OwnedProjectListItem[]> {
  const supabase = db(client);
  const { data, error } = await supabase
    .from('projects')
    .select(PROJECT_SELECT)
    .eq('owner_account_id', accountId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  const owned = (data || []) as ProjectRecord[];

  const { data: memberRows, error: memberErr } = await supabase
    .from('project_members')
    .select('project_id')
    .eq('account_id', accountId)
    .limit(MAX_PROJECTS_JOINED_PER_ACCOUNT);
  if (memberErr) throw new Error(memberErr.message);
  const memberIds = ((memberRows || []) as Array<{ project_id: string }>).map((r) => String(r.project_id));
  let joined: ProjectRecord[] = [];
  if (memberIds.length) {
    const { data: rows, error: joinedErr } = await supabase.from('projects').select(PROJECT_SELECT).in('id', memberIds);
    if (joinedErr) throw new Error(joinedErr.message);
    joined = (rows || []) as ProjectRecord[];
  }

  const projects = [
    ...owned.map((p) => ({ row: p, role: 'owner' as const })),
    ...joined.filter((p) => !owned.some((o) => o.id === p.id)).map((p) => ({ row: p, role: 'member' as const })),
  ];
  if (projects.length === 0) return [];

  const nowIso = new Date().toISOString();
  let counts = new Map<string, { live: number; total: number }>();
  try {
    const pairs = await Promise.all(
      projects.map(async ({ row }) => {
        const [live, total] = await Promise.all([
          supabase
            .from('tasks')
            .select('id', { count: 'exact', head: true })
            .eq('project_id', row.id)
            .eq('status', 'live')
            .gt('ends_at', nowIso),
          supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('project_id', row.id),
        ]);
        if (live.error) throw new Error(live.error.message);
        if (total.error) throw new Error(total.error.message);
        return [row.id, { live: live.count || 0, total: total.count || 0 }] as const;
      })
    );
    counts = new Map(pairs);
  } catch {
    counts = new Map();
  }

  return projects.map(({ row, role }) => ({
    ...ownedProjectFrom(row),
    role,
    activeTasks: counts.get(row.id)?.live || 0,
    totalTasks: counts.get(row.id)?.total || 0,
  }));
}

function ownedProjectFrom(row: ProjectRecord): OwnedProject {
  return {
    id: row.id,
    handle: row.handle,
    name: row.name,
    description: String(row.description || ''),
    verified: Boolean(row.verified_at),
    image: row.image || null,
  };
}

export type ProjectActivity = { at: string; label: string };

export type LeaderboardEntry = { rank: number; username: string; xp: number; wins: number };

/** totalXp and earners cover everyone, not only the entries returned. */
export type ProjectLeaderboard = { entries: LeaderboardEntry[]; totalXp: number; earners: number };

/**
 * The four figures at the top of a project page. Participants are distinct
 * accounts across every task of the project; recentInitials are only the first
 * letters of the latest entrants, enough for an avatar stack and no more.
 */
export type ProjectStats = {
  participants: number;
  recentInitials: string[];
  liveTasks: number;
  endedTasks: number;
  totalTasks: number;
  xpTotal: number;
  xpEarners: number;
  /** Rewards paid out on chain, per asset. Empty until task rewards are locked and paid by Flizy. */
  rewardsPaid: Array<{ asset: string; amount: string }>;
};

/** One reward paid to a winner, for the Recent rewards list. */
export type RecentReward = { username: string; amount: string; asset: string; at: string; txUrl: string | null };

export type PublicProject = {
  handle: string;
  name: string;
  description: string;
  verified: boolean;
  image: string | null;
  banner: string | null;
  createdAt: string | null;
  stats: ProjectStats;
  recentRewards: RecentReward[];
  links: ProjectLink[];
  tasks: TaskListItem[];
  activity: ProjectActivity[];
  leaderboard: ProjectLeaderboard;
  /** The signed-in reader's standing, so the page can offer Manage. Null for everyone else. */
  viewerRole: ProjectRole | null;
};

const LEADERBOARD_LIMIT = 50;

/**
 * The public project page.
 *
 * owner_account_id is read only to answer viewerRole and is never returned.
 * The account that manages the project is an authorisation fact, not something
 * the profile shows. The leaderboard names winners by username, which the
 * completed tasks' winner lists already show publicly.
 */
export async function getPublicProject(
  handle: string,
  client?: Db,
  opts: { viewerAccountId?: string | null } = {}
): Promise<PublicProject | null> {
  const supabase = db(client);
  const project = await projectByHandle(handle, supabase);
  if (!project) return null;

  const rows = await tasksForProject(project.id, client);
  const [tasks, leaderboard, viewerRole] = await Promise.all([
    projectTaskItems(project, rows, client),
    projectLeaderboard(project.id, LEADERBOARD_LIMIT, supabase),
    opts.viewerAccountId ? projectAccess(opts.viewerAccountId, project.id, supabase) : Promise.resolve(null),
  ]);
  const stats = await projectStats(project.id, leaderboard, supabase);

  return {
    handle: project.handle,
    name: project.name,
    description: String(project.description || ''),
    verified: Boolean(project.verified_at),
    image: project.image || null,
    banner: project.banner || null,
    createdAt: project.created_at || null,
    stats,
    recentRewards: [],
    links: projectLinksFrom(project.links),
    tasks,
    activity: activityFrom(rows),
    leaderboard,
    viewerRole,
  };
}

async function projectByHandle(handle: string, supabase: Db): Promise<ProjectRecord | null> {
  const checked = validateUsername(handle);
  if (!checked.ok) return null;
  const { data, error } = await supabase.from('projects').select(PROJECT_PAGE_SELECT).eq('handle', checked.username).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ProjectRecord | null) || null;
}

async function projectTaskItems(project: ProjectRecord, rows: TaskRow[], client?: Db): Promise<TaskListItem[]> {
  return toListItems(rows, null, client, {
    kind: 'project',
    name: project.name,
    handle: project.handle,
    verified: Boolean(project.verified_at),
  });
}

/** How many entrant letters the avatar stack shows. */
const RECENT_INITIALS = 3;

async function projectStats(projectId: string, leaderboard: ProjectLeaderboard, supabase: Db): Promise<ProjectStats> {
  const nowIso = new Date().toISOString();
  const [participantRows, liveTasks, totalTasks, recentInitials] = await Promise.all([
    supabase.rpc('project_participant_stats', { p_project_id: projectId }),
    countRows(
      supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('status', 'live')
        .gt('ends_at', nowIso)
    ),
    countRows(supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('project_id', projectId)),
    recentEntrantInitials(projectId, supabase),
  ]);
  if (participantRows.error) throw new Error(participantRows.error.message);
  const first = (Array.isArray(participantRows.data) ? participantRows.data[0] : participantRows.data) as
    | { participants?: number | string }
    | null;

  return {
    participants: Number(first?.participants) || 0,
    recentInitials,
    liveTasks,
    endedTasks: Math.max(0, totalTasks - liveTasks),
    totalTasks,
    xpTotal: leaderboard.totalXp,
    xpEarners: leaderboard.earners,
    rewardsPaid: [],
  };
}

/** First letters of the latest distinct entrants, newest first. Nothing else about them leaves. */
async function recentEntrantInitials(projectId: string, supabase: Db): Promise<string[]> {
  const { data: taskRows, error: taskErr } = await supabase
    .from('tasks')
    .select('id')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);
  if (taskErr) throw new Error(taskErr.message);
  const taskIds = ((taskRows || []) as Array<{ id: string }>).map((t) => String(t.id));
  if (!taskIds.length) return [];

  const { data: subs, error: subErr } = await supabase
    .from('task_submissions')
    .select('account_id, created_at')
    .in('task_id', taskIds)
    .order('created_at', { ascending: false })
    .limit(30);
  if (subErr) throw new Error(subErr.message);
  const ids: string[] = [];
  for (const row of (subs || []) as Array<{ account_id: string }>) {
    const id = String(row.account_id);
    if (!ids.includes(id)) ids.push(id);
    if (ids.length >= RECENT_INITIALS) break;
  }
  if (!ids.length) return [];

  const { data: accounts, error: accErr } = await supabase.from('accounts').select('id, username').in('id', ids);
  if (accErr) throw new Error(accErr.message);
  const letterOf = new Map(
    ((accounts || []) as Array<{ id: string; username: string | null }>).map((a) => [
      String(a.id),
      (a.username || '?').slice(0, 1).toUpperCase(),
    ])
  );
  return ids.map((id) => letterOf.get(id) || '?');
}

async function projectLeaderboard(projectId: string, limit: number, supabase: Db): Promise<ProjectLeaderboard> {
  const { data, error } = await supabase.rpc('project_xp_leaderboard', { p_project_id: projectId, p_limit: limit });
  if (error) throw new Error(error.message);
  const rows = (data || []) as Array<{
    account_id: string;
    xp: number | string;
    wins: number | string;
    total_xp: number | string;
    earners: number | string;
  }>;
  if (!rows.length) return { entries: [], totalXp: 0, earners: 0 };

  const { data: accounts, error: accErr } = await supabase
    .from('accounts')
    .select('id, username')
    .in('id', rows.map((r) => String(r.account_id)));
  if (accErr) throw new Error(accErr.message);
  const nameOf = new Map(
    ((accounts || []) as Array<{ id: string; username: string | null }>).map((a) => [String(a.id), a.username || 'someone'])
  );

  return {
    entries: rows.map((r, i) => ({
      rank: i + 1,
      username: nameOf.get(String(r.account_id)) || 'someone',
      xp: Number(r.xp) || 0,
      wins: Number(r.wins) || 0,
    })),
    totalXp: Number(rows[0].total_xp) || 0,
    earners: Number(rows[0].earners) || 0,
  };
}

async function tasksForProject(projectId: string, client?: Db): Promise<TaskRow[]> {
  const supabase = db(client);
  const { data, error } = await supabase
    .from('tasks')
    .select(TASK_SELECT)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(error.message);
  return (data || []) as TaskRow[];
}

function activityFrom(rows: TaskRow[]): ProjectActivity[] {
  const events: ProjectActivity[] = [];
  for (const row of rows) {
    const state = deriveTaskState(row);
    if (row.created_at) {
      events.push({ at: row.created_at, label: `Published #${row.ref} ${row.title}` });
    }
    if (state === 'review') {
      events.push({ at: row.ends_at, label: `#${row.ref} is under review` });
    } else if (state === 'completed' && row.completed_at) {
      events.push({ at: row.completed_at, label: `Winners published for #${row.ref}` });
    } else if (state === 'cancelled' && row.cancelled_at) {
      events.push({ at: row.cancelled_at, label: `#${row.ref} was cancelled` });
    }
  }
  return events
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 30);
}

export type ProjectMember = { username: string; role: ProjectRole };

export type ProjectWorkspace = OwnedProject & {
  role: ProjectRole;
  banner: string | null;
  createdAt: string | null;
  stats: ProjectStats;
  recentRewards: RecentReward[];
  activity: ProjectActivity[];
  links: ProjectLink[];
  liveTasks: TaskListItem[];
  endedTasks: TaskListItem[];
  liveCap: number;
  totalTasks: number;
  leaderboard: ProjectLeaderboard;
  members: ProjectMember[];
};

const PROJECT_NOT_FOUND = 'Project not found.';
const OWNER_ONLY = 'Only the project owner can manage members.';

/**
 * The in-app workspace for one project, for its owner or a member.
 *
 * Anyone else gets null, the same answer as a handle that does not exist, so
 * the route cannot be used to learn which accounts run which project.
 */
export async function getProjectWorkspace(
  accountId: string,
  handle: string,
  client?: Db
): Promise<ProjectWorkspace | null> {
  const supabase = db(client);
  const project = await projectByHandle(handle, supabase);
  if (!project) return null;
  const role = await projectAccess(accountId, project.id, supabase);
  if (!role) return null;

  const rows = await tasksForProject(project.id, client);
  const [tasks, leaderboard, members] = await Promise.all([
    projectTaskItems(project, rows, client),
    projectLeaderboard(project.id, LEADERBOARD_LIMIT, supabase),
    projectMembers(project, supabase),
  ]);
  const stats = await projectStats(project.id, leaderboard, supabase);

  return {
    ...ownedProjectFrom(project),
    role,
    banner: project.banner || null,
    createdAt: project.created_at || null,
    stats,
    recentRewards: [],
    activity: activityFrom(rows),
    links: projectLinksFrom(project.links),
    liveTasks: tasks.filter((t) => t.state === 'live'),
    endedTasks: tasks.filter((t) => t.state !== 'live'),
    liveCap: MAX_LIVE_TASKS_PER_PROJECT,
    totalTasks: stats.totalTasks,
    leaderboard,
    members,
  };
}

/** The owner first, then members in the order they were added. Usernames only. */
async function projectMembers(project: ProjectRecord, supabase: Db): Promise<ProjectMember[]> {
  const { data, error } = await supabase
    .from('project_members')
    .select('account_id, created_at')
    .eq('project_id', project.id)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  const memberIds = ((data || []) as Array<{ account_id: string }>).map((r) => String(r.account_id));
  const ids = [String(project.owner_account_id), ...memberIds];

  const { data: accounts, error: accErr } = await supabase.from('accounts').select('id, username').in('id', ids);
  if (accErr) throw new Error(accErr.message);
  const nameOf = new Map(
    ((accounts || []) as Array<{ id: string; username: string | null }>).map((a) => [String(a.id), a.username || 'someone'])
  );
  return ids.map((id, i) => ({ username: nameOf.get(id) || 'someone', role: i === 0 ? 'owner' : 'member' }));
}

export type ProjectPatch = {
  name?: string;
  description?: string;
  links?: ProjectLink[];
  /** A data URL to set, or null to remove the picture. Absent leaves it as it is. */
  image?: string | null;
  /** The same for the hero banner. */
  banner?: string | null;
};

/**
 * Edit a project's details. The owner or a member may. The handle is not
 * editable: it is the address people have already shared.
 */
export async function updateProject(
  accountId: string,
  handle: string,
  patch: ProjectPatch,
  client?: Db
): Promise<OwnedProject & { banner: string | null }> {
  const supabase = db(client);
  const project = await projectByHandle(handle, supabase);
  if (!project || !(await projectAccess(accountId, project.id, supabase))) throw new ClientError(PROJECT_NOT_FOUND);

  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim();
    if (name.length < 2 || name.length > 60) throw new ClientError('Project name must be 2 to 60 characters.');
    // Only a new name is checked, so a member can still save other details on
    // a project an admin named.
    if (name !== project.name) await refuseBrandName(accountId, [name], supabase);
    update.name = name;
  }
  if (patch.description !== undefined) {
    const description = String(patch.description || '').trim();
    if (description.length > 800) throw new ClientError('Description is too long.');
    update.description = description;
  }
  if (patch.links !== undefined) update.links = checkedProjectLinks(patch.links);
  if (patch.image !== undefined) update.image = checkedProjectImage(patch.image);
  if (patch.banner !== undefined) update.banner = checkedProjectBanner(patch.banner);
  if (!Object.keys(update).length) return { ...ownedProjectFrom(project), banner: project.banner || null };
  update.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('projects')
    .update(update)
    .eq('id', project.id)
    .select(PROJECT_PAGE_SELECT)
    .single();
  if (error) throw new Error(error.message);
  const saved = data as ProjectRecord;
  return { ...ownedProjectFrom(saved), banner: saved.banner || null };
}

/** Loads a project for adding a member, refusing anyone but its owner. */
async function requireProjectOwner(accountId: string, handle: string, supabase: Db): Promise<ProjectRecord> {
  const project = await projectByHandle(handle, supabase);
  const role = project ? await projectAccess(accountId, project.id, supabase) : null;
  if (!project || !role) throw new ClientError(PROJECT_NOT_FOUND);
  if (role !== 'owner') throw new ClientError(OWNER_ONLY);
  return project;
}

async function accountIdForUsername(raw: string, supabase: Db): Promise<string> {
  const checked = validateUsername(String(raw || '').replace(/^@/, ''));
  if (!checked.ok) throw new ClientError(checked.error);
  const { data, error } = await supabase.from('accounts').select('id').eq('username', checked.username).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ClientError('No Flizy account has that username.');
  return String((data as { id: string }).id);
}

export async function addProjectMember(
  accountId: string,
  handle: string,
  username: string,
  client?: Db
): Promise<ProjectMember[]> {
  const supabase = db(client);
  const project = await requireProjectOwner(accountId, handle, supabase);
  const memberId = await accountIdForUsername(username, supabase);
  if (memberId === String(project.owner_account_id)) throw new ClientError('You already own this project.');

  const count = await countRows(
    supabase.from('project_members').select('id', { count: 'exact', head: true }).eq('project_id', project.id)
  );
  if (count >= MAX_MEMBERS_PER_PROJECT) {
    throw new ClientError(`A project can have ${MAX_MEMBERS_PER_PROJECT} members.`);
  }
  // Nobody is asked before being added, so how many projects can be put on one
  // account's list is bounded here, and that member can always leave.
  const joined = await countRows(
    supabase.from('project_members').select('id', { count: 'exact', head: true }).eq('account_id', memberId)
  );
  if (joined >= MAX_PROJECTS_JOINED_PER_ACCOUNT) {
    throw new ClientError('That account is on too many projects.');
  }

  const { error } = await supabase
    .from('project_members')
    .insert({ project_id: project.id, account_id: memberId, added_by: accountId });
  if (error) {
    if (error.code === '23505') throw new ClientError('Already a member.');
    throw new Error(error.message);
  }
  return projectMembers(project, supabase);
}

/** The owner removes anyone; a member may remove only themselves, which is leaving. */
export async function removeProjectMember(
  accountId: string,
  handle: string,
  username: string,
  client?: Db
): Promise<ProjectMember[]> {
  const supabase = db(client);
  const project = await projectByHandle(handle, supabase);
  const role = project ? await projectAccess(accountId, project.id, supabase) : null;
  if (!project || !role) throw new ClientError(PROJECT_NOT_FOUND);
  const memberId = await accountIdForUsername(username, supabase);
  if (role !== 'owner' && memberId !== accountId) throw new ClientError(OWNER_ONLY);
  const { error } = await supabase
    .from('project_members')
    .delete()
    .eq('project_id', project.id)
    .eq('account_id', memberId);
  if (error) throw new Error(error.message);
  return projectMembers(project, supabase);
}

/**
 * Any signed-in account may publish a task, personal or as a project.
 *
 * The row has to exist. A session for a deleted account must not publish.
 * Admin is not a gate. What bounds an open door is in createTask and
 * createProject: the per-account ceilings and the brand-name check.
 */
export async function canCreateTasks(accountId: string, client?: Db): Promise<boolean> {
  if (!accountId) return false;
  const supabase = db(client);
  const { data } = await supabase.from('accounts').select('id').eq('id', accountId).maybeSingle();
  return Boolean(data);
}

export type EnteredTaskCounts = Record<TaskState, number>;

/** Entries counted for Home. More than anyone enters in practice, and a bound on the read. */
const ENTERED_TASKS_READ_MAX = 500;

/**
 * How many tasks this account has entered, by where each task stands now.
 *
 * Counts only, for the Home summary. Which tasks they are, and what was
 * entered, stay on the task pages. The state comes from deriveTaskState, so a
 * task past its deadline reads as in review here exactly as it does on Explore.
 */
export async function countEnteredTasks(accountId: string, client?: Db): Promise<EnteredTaskCounts> {
  const counts: EnteredTaskCounts = { live: 0, review: 0, completed: 0, cancelled: 0 };
  if (!accountId) return counts;
  const supabase = db(client);

  const { data: entries, error: entriesError } = await supabase
    .from('task_submissions')
    .select('task_id')
    .eq('account_id', accountId)
    .limit(ENTERED_TASKS_READ_MAX);
  if (entriesError) throw new Error(entriesError.message);
  const taskIds = [...new Set((entries || []).map((e) => String((e as { task_id: string }).task_id)))];
  if (!taskIds.length) return counts;

  const { data: rows, error: tasksError } = await supabase
    .from('tasks')
    .select('id, status, ends_at')
    .in('id', taskIds);
  if (tasksError) throw new Error(tasksError.message);

  const now = Date.now();
  for (const row of (rows || []) as Array<Pick<TaskRow, 'status' | 'ends_at'>>) {
    counts[deriveTaskState(row, now)] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Saves and Featured
// ---------------------------------------------------------------------------

/** How many tasks one account may keep saved. A bound on the table, not a product limit. */
export const TASK_SAVES_MAX = 200;

async function taskIdForRef(ref: number, supabase: Db): Promise<string> {
  if (!Number.isInteger(ref) || ref <= 0) throw new ClientError('Task not found.');
  const { data, error } = await supabase.from('tasks').select('id').eq('ref', ref).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ClientError('Task not found.');
  return String((data as { id: string }).id);
}

/**
 * Save a task to come back to, or drop the save. Any task can be saved, in any
 * state: somebody may want a finished one for its winners. Returns the new state.
 */
export async function setTaskSaved(accountId: string, ref: number, on: boolean, client?: Db): Promise<boolean> {
  if (!accountId) throw new ClientError('Not logged in');
  const supabase = db(client);
  const taskId = await taskIdForRef(ref, supabase);

  if (!on) {
    const { error } = await supabase.from('task_saves').delete().eq('account_id', accountId).eq('task_id', taskId);
    if (error) throw new Error(error.message);
    return false;
  }

  const already = await savedTaskIds(accountId, [taskId], supabase);
  if (already.size) return true;
  const count = await countRows(
    supabase.from('task_saves').select('task_id', { count: 'exact', head: true }).eq('account_id', accountId)
  );
  if (count >= TASK_SAVES_MAX) {
    throw new ClientError(`You can keep ${TASK_SAVES_MAX} tasks saved. Remove one to save another.`);
  }
  const { error } = await supabase
    .from('task_saves')
    .upsert({ account_id: accountId, task_id: taskId }, { onConflict: 'account_id,task_id' });
  if (error) throw new Error(error.message);
  return true;
}

/**
 * Feature a task, or take the mark off. Flizy admins only: the mark puts a task
 * at the top of Explore, which is the product speaking, not the creator.
 */
export async function setTaskFeatured(accountId: string, ref: number, on: boolean, client?: Db): Promise<boolean> {
  if (!accountId) throw new ClientError('Not logged in');
  const supabase = db(client);
  if (!(await isAdminAccount(accountId, supabase))) {
    throw new ClientError('Only Flizy admins can feature a task.');
  }
  const taskId = await taskIdForRef(ref, supabase);
  const { error } = await supabase
    .from('tasks')
    .update({ featured_at: on ? new Date().toISOString() : null })
    .eq('id', taskId);
  if (error) throw new Error(error.message);
  return on;
}

export type MyTaskRelation = 'saved' | 'joined' | 'created';
export type MyTaskItem = TaskListItem & { relations: MyTaskRelation[] };

/** Rows read per source for My tasks. The list shows the newest of each. */
const MY_TASKS_PER_SOURCE = 60;

/**
 * The viewer's own tasks: the ones they saved, entered or published, newest
 * deadline first, each once with every way it is theirs. Entries themselves are
 * not included, only the fact of having entered.
 */
export async function listMyTasks(accountId: string, client?: Db): Promise<MyTaskItem[]> {
  if (!accountId) return [];
  const supabase = db(client);

  const [saves, entries, created] = await Promise.all([
    supabase
      .from('task_saves')
      .select('task_id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(MY_TASKS_PER_SOURCE),
    supabase
      .from('task_submissions')
      .select('task_id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(MY_TASKS_PER_SOURCE),
    supabase
      .from('tasks')
      .select('id')
      .eq('creator_account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(MY_TASKS_PER_SOURCE),
  ]);
  if (saves.error) throw new Error(saves.error.message);
  if (entries.error) throw new Error(entries.error.message);
  if (created.error) throw new Error(created.error.message);

  const relations = new Map<string, MyTaskRelation[]>();
  const mark = (rows: unknown[] | null, key: 'task_id' | 'id', relation: MyTaskRelation) => {
    for (const row of (rows || []) as Array<Record<string, unknown>>) {
      const id = String(row[key]);
      const list = relations.get(id) || [];
      if (!list.includes(relation)) list.push(relation);
      relations.set(id, list);
    }
  };
  mark(saves.data, 'task_id', 'saved');
  mark(entries.data, 'task_id', 'joined');
  mark(created.data, 'id', 'created');
  if (!relations.size) return [];

  const { data, error } = await supabase.from('tasks').select(TASK_SELECT).in('id', [...relations.keys()]);
  if (error) throw new Error(error.message);
  const rows = ((data || []) as TaskRow[]).sort(
    (a, b) => new Date(b.ends_at).getTime() - new Date(a.ends_at).getTime()
  );

  const items = await toListItems(rows, accountId, client);
  return items.map((item, i) => ({ ...item, relations: relations.get(rows[i].id) || [] }));
}
