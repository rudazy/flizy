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
  'id, ref, creator_account_id, project_id, title, description, reward_kind, reward_asset, reward_total, reward_display, winners_count, distribution, requires_x_identity, ends_at, status, completed_at, cancelled_at, created_at';

export type TaskListItem = {
  ref: number;
  title: string;
  rewardDisplay: string;
  winnersCount: number;
  participants: number;
  endsAt: string;
  state: TaskState;
  creator: { kind: 'project' | 'personal'; name: string; handle: string | null };
};

/**
 * The discovery list. Counts only, no submission contents: the Live page is for
 * deciding whether to open something, and showing entries there would let people
 * copy each other while the task is still running.
 */
export async function listTasks(
  opts: { state?: 'live' | 'ended' } = {},
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
  if (!picked.length) return [];

  const [counts, creators] = await Promise.all([
    participantCounts(picked.map((r) => r.id), client),
    creatorLabels(picked, client),
  ]);

  return picked.map((r) => ({
    ref: r.ref,
    title: r.title,
    rewardDisplay: r.reward_display,
    winnersCount: r.winners_count,
    participants: counts.get(r.id) || 0,
    endsAt: r.ends_at,
    state: deriveTaskState(r, now),
    creator: creators.get(r.id) || { kind: 'personal', name: 'Flizy', handle: null },
  }));
}

const LIST_LIMIT = 60;

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

  const projects = new Map<string, { name: string; handle: string }>();
  if (projectIds.length) {
    const { data } = await supabase.from('projects').select('id, name, handle').in('id', projectIds);
    for (const p of data || []) {
      const row = p as { id: string; name: string; handle: string };
      projects.set(row.id, { name: row.name, handle: row.handle });
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
      out.set(r.id, { kind: 'project', name: p.name, handle: p.handle });
    } else {
      const username = accounts.get(r.creator_account_id) || 'someone';
      out.set(r.id, { kind: 'personal', name: `@${username}`, handle: username });
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
  creator: TaskListItem['creator'];
  isCreator: boolean;
  requirements: Array<{ id: string; kind: string; label: string }>;
  links: Array<{ kind: string; label: string; url: string }>;
  viewerHasEntered: boolean;
  winners: Array<{ place: number; username: string; submissionRef: number; url: string | null; rewardNote: string }>;
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

  const [counts, creators, reqs, links, entered, winners] = await Promise.all([
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
  ]);

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
    creator: creators.get(task.id) || { kind: 'personal', name: 'Flizy', handle: null },
    isCreator: Boolean(viewer && viewer === task.creator_account_id),
    requirements: ((reqs as { data: unknown[] }).data || []) as TaskDetail['requirements'],
    links: ((links as { data: unknown[] }).data || []) as TaskDetail['links'],
    viewerHasEntered: Boolean((entered as { data: unknown }).data),
    winners,
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
export const MAX_LIVE_TASKS_PER_ACCOUNT = 10;
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
  throw new ClientError('Names and titles cannot use the Flizy name.');
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

  // A project may only be used by the account that owns it. Without this a ref
  // guessed from another account would let anyone publish under their name.
  let projectId: string | null = null;
  if (input.projectId) {
    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', input.projectId)
      .eq('owner_account_id', accountId)
      .maybeSingle();
    if (!project) throw new ClientError('That project is not yours.');
    projectId = String((project as { id: string }).id);
  }

  await refuseBrandName(accountId, [title], supabase);

  const nowMs = Date.now();
  const live = await countRows(
    supabase
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('creator_account_id', accountId)
      .eq('status', 'live')
      .gt('ends_at', new Date(nowMs).toISOString())
  );
  if (live >= MAX_LIVE_TASKS_PER_ACCOUNT) {
    throw new ClientError(`You can have ${MAX_LIVE_TASKS_PER_ACCOUNT} live tasks at once.`);
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
    })
    .select('id, ref')
    .single();
  if (error) throw new Error(error.message);
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
};

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

function checkedProjectLinks(input: ProjectLink[] | undefined): ProjectLink[] {
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

export async function createProject(
  accountId: string,
  input: { handle: string; name: string; description?: string; links?: ProjectLink[] },
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

  const supabase = db(client);
  if (await isUsernameReserved(supabase, handle)) throw new ClientError(USERNAME_UNAVAILABLE);

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
    .insert({ owner_account_id: accountId, handle, name, description, links })
    .select('id, handle, name, description')
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

/** The projects an account may publish as. The owner id is not returned. */
export async function listOwnProjects(accountId: string, client?: Db) {
  const supabase = db(client);
  const { data, error } = await supabase
    .from('projects')
    .select('id, handle, name, description')
    .eq('owner_account_id', accountId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []) as OwnedProject[];
}

export type ProjectActivity = { at: string; label: string };

export type PublicProject = {
  handle: string;
  name: string;
  description: string;
  links: ProjectLink[];
  tasks: TaskListItem[];
  activity: ProjectActivity[];
};

/**
 * The public project page.
 *
 * owner_account_id is never selected. The account that manages the project is
 * an authorisation fact, not something the profile shows.
 */
export async function getPublicProject(handle: string, client?: Db): Promise<PublicProject | null> {
  const checked = validateUsername(handle);
  if (!checked.ok) return null;

  const supabase = db(client);
  const { data, error } = await supabase
    .from('projects')
    .select('id, handle, name, description, links')
    .eq('handle', checked.username)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const project = data as {
    id: string;
    handle: string;
    name: string;
    description: string | null;
    links: unknown;
  };
  const rows = await tasksForProject(project.id, client);
  const now = Date.now();
  const [counts, creators] = rows.length
    ? await Promise.all([
        participantCounts(rows.map((r) => r.id), client),
        creatorLabels(rows, client),
      ])
    : [new Map<string, number>(), new Map<string, TaskListItem['creator']>()];

  const tasks = rows.map((r) => ({
    ref: r.ref,
    title: r.title,
    rewardDisplay: r.reward_display,
    winnersCount: r.winners_count,
    participants: counts.get(r.id) || 0,
    endsAt: r.ends_at,
    state: deriveTaskState(r, now),
    creator: creators.get(r.id) || { kind: 'project' as const, name: project.name, handle: project.handle },
  }));

  return {
    handle: project.handle,
    name: project.name,
    description: String(project.description || ''),
    links: projectLinksFrom(project.links),
    tasks,
    activity: activityFrom(rows),
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
