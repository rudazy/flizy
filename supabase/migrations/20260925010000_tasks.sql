-- Tasks: an open marketplace of work with a declared reward.
--
-- An individual or a project publishes a task, participants submit an entry, and
-- after the deadline the creator picks winners. This migration carries the whole
-- lifecycle except the money: rewards are declared here, not held. Crypto escrow
-- and payout arrive in a later migration as an additive `task_escrows` table, so
-- nothing below has to be reshaped for it.
--
-- Three decisions worth stating, because they are the ones a reader will
-- otherwise have to reverse-engineer.
--
-- 1. THE LIFECYCLE IS DERIVED, NOT STORED.
--
--    `status` records only what a person decided: live, completed, cancelled.
--    Whether a live task is still accepting entries is a question about the
--    clock, answered at read time:
--
--      LIVE          status = 'live'      and ends_at >  now()
--      UNDER REVIEW  status = 'live'      and ends_at <= now()
--      COMPLETED     status = 'completed'
--      CANCELLED     status = 'cancelled'
--
--    There is no scheduler in this product. No Vercel cron, no job runner; the
--    only recurring timer is a per-process outbox poll. A design that needed a
--    sweep to move a task from live to ended would be a design with a step that
--    can silently stop running, and the first anyone would know is a task
--    accepting entries a week after it closed. Same reasoning, and the same
--    shape, as `usableOnly` in lib/trusted.js.
--
-- 2. AUTHORSHIP AND ATTRIBUTION ARE DIFFERENT COLUMNS.
--
--    `creator_account_id` is always set and is the only thing that authorises a
--    creator-only action. `project_id` is nullable and is only ever display: a
--    task shown as FLIZY is still owned by the account behind it. Collapsing
--    the two would mean either a project cannot act or an owner cannot be
--    checked without a join.
--
-- 3. THE SUBMISSION WINDOW IS ENFORCED BY A TRIGGER.
--
--    One route writes submissions today. The deadline is the one rule a writer
--    added later must not be able to opt out of: a rule stated only in
--    application code holds for the writers that remember to apply it. Cheaper
--    to put it under the table now than to find the second writer later.
--
-- Additive only. Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Projects
--
-- A person does not need a project to create a task, so this is optional and
-- stands apart from `accounts`. The handle is reached at /project/<handle> and
-- follows the username rules, ^[a-z][a-z0-9]{2,23}$, so it cannot collide with
-- /pay/[code], which is a single path segment. A handle and a username may not
-- be the same name: section 8 holds that in both directions. The application
-- also checks the handle against public.reserved_usernames, so `project/admin`
-- is refused for the same reason `@admin` is.
-- ---------------------------------------------------------------------------

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_account_id uuid not null references public.accounts (id) on delete cascade,
  handle text not null,
  name text not null,
  created_at timestamptz not null default now(),
  constraint projects_handle_format check (handle ~ '^[a-z][a-z0-9]{2,23}$')
);

-- Case-insensitive uniqueness. Two projects differing only in case would be one
-- identity as far as a reader of a URL is concerned.
create unique index if not exists projects_handle_unique_idx
  on public.projects (lower(handle));
create index if not exists projects_owner_idx on public.projects (owner_account_id);

comment on table public.projects is
  'Optional publishing identity. A task may be attributed to one, but the owning account is what authorises.';
comment on column public.projects.handle is
  'Reached at /project/<handle>. Same character rules as a username so the two namespaces cannot be confused.';

-- ---------------------------------------------------------------------------
-- 2. Tasks
-- ---------------------------------------------------------------------------

-- The public number (#184 in the product). Its own sequence rather than a serial
-- column, so the first task does not advertise itself as number one.
create sequence if not exists public.task_ref_seq as bigint start with 100 increment by 1;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  ref bigint not null default nextval('public.task_ref_seq'),
  creator_account_id uuid not null references public.accounts (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  title text not null,
  description text not null default '',
  reward_kind text not null,
  reward_asset text,
  reward_total numeric(38, 18),
  reward_display text not null default '',
  winners_count integer not null default 1,
  distribution jsonb not null default '[]'::jsonb,
  requires_x_identity boolean not null default false,
  ends_at timestamptz not null,
  status text not null default 'live',
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint tasks_ref_unique unique (ref),
  constraint tasks_status_check check (status in ('live', 'completed', 'cancelled')),
  constraint tasks_reward_kind_check
    check (reward_kind in ('crypto', 'wl', 'nft', 'token', 'product', 'custom')),
  constraint tasks_winners_count_check check (winners_count between 1 and 100),
  constraint tasks_title_check check (length(btrim(title)) between 3 and 140),
  -- A terminal state carries its timestamp and a live one does not, so "is this
  -- finished" can never be answered two different ways. Same pairing rule as
  -- pots.status / pots.closed_at.
  constraint tasks_completed_at_check
    check ((status = 'completed') = (completed_at is not null)),
  constraint tasks_cancelled_at_check
    check ((status = 'cancelled') = (cancelled_at is not null))
);

-- Serves the discovery lists, which are the most-read query in the feature:
-- live tasks ordered by deadline, and ended ones by when they closed.
create index if not exists tasks_status_ends_idx on public.tasks (status, ends_at desc);
create index if not exists tasks_creator_idx on public.tasks (creator_account_id);
create index if not exists tasks_project_idx on public.tasks (project_id);

comment on table public.tasks is
  'A unit of work with a declared reward. Whether it still accepts entries is derived from ends_at, never stored.';
comment on column public.tasks.ref is
  'The public task number. Stable and shown to people; the uuid is internal.';
comment on column public.tasks.creator_account_id is
  'The only column that authorises a creator-only action. project_id is display.';
comment on column public.tasks.status is
  'What a person decided: live, completed, cancelled. Ended and under-review are derived from ends_at.';
comment on column public.tasks.reward_total is
  'Declared amount, for display and for the escrow work that follows. Nothing is held yet.';
comment on column public.tasks.distribution is
  'Array of {place, amount} the creator configured. Display until escrow exists.';
comment on column public.tasks.requires_x_identity is
  'When true a participant must have linked X. Leave false until X OAuth is confirmed working.';

-- ---------------------------------------------------------------------------
-- 3. What a task asks for, and what it points at
-- ---------------------------------------------------------------------------

create table if not exists public.task_requirements (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  position integer not null default 0,
  kind text not null,
  label text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Deliberately narrow. image, video and file need an upload capability that
  -- does not exist yet, and a kind nothing can accept would be a promise the
  -- submit form cannot keep.
  constraint task_requirements_kind_check check (kind in ('x_post', 'link', 'text'))
);

create index if not exists task_requirements_task_idx
  on public.task_requirements (task_id, position);

create table if not exists public.task_links (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  position integer not null default 0,
  kind text not null default 'custom',
  label text not null,
  url text not null,
  created_at timestamptz not null default now(),
  constraint task_links_url_check check (url ~* '^https://'),
  constraint task_links_kind_check check (kind in ('website', 'docs', 'x', 'custom'))
);

create index if not exists task_links_task_idx on public.task_links (task_id, position);

comment on table public.task_links is
  'References a creator adds over the life of a task. https only: a task page is public and must not carry a plaintext link.';

-- ---------------------------------------------------------------------------
-- 4. Submissions
--
-- Two uniqueness rules, for two different abuses. One entry per participant
-- stops somebody flooding a task. One entry per URL stops somebody submitting
-- another person's post, which is the whole of the "already submitted by another
-- participant" case in the product.
-- ---------------------------------------------------------------------------

create table if not exists public.task_submissions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  ref integer not null,
  account_id uuid not null references public.accounts (id) on delete cascade,
  requirement_id uuid references public.task_requirements (id) on delete set null,
  content_url text,
  content_text text,
  verification text not null default 'unverified',
  x_external_id text,
  created_at timestamptz not null default now(),
  constraint task_submissions_one_per_account unique (task_id, account_id),
  constraint task_submissions_ref_unique unique (task_id, ref),
  constraint task_submissions_verification_check
    check (verification in ('x_verified', 'unverified')),
  -- An entry has to be something. A row with neither a link nor text is not a
  -- submission, it is a click.
  constraint task_submissions_content_check
    check (coalesce(nullif(btrim(content_url), ''), nullif(btrim(content_text), '')) is not null)
);

-- The same post may not be entered twice, whoever enters it. Lowercased because
-- a URL's host and path case must not create a second identity for one post.
create unique index if not exists task_submissions_url_unique_idx
  on public.task_submissions (task_id, lower(content_url))
  where content_url is not null;

create index if not exists task_submissions_task_idx
  on public.task_submissions (task_id, created_at desc);
create index if not exists task_submissions_account_idx
  on public.task_submissions (account_id);

comment on table public.task_submissions is
  'One entry per participant per task. Never exposed publicly while the task is live.';
comment on column public.task_submissions.ref is
  'Per-task submission number shown in review and in the public winner list.';
comment on column public.task_submissions.verification is
  'x_verified means the URL handle matched the linked X identity. Display-handle based, so a signal and not proof.';

-- ---------------------------------------------------------------------------
-- 5. The submission window, enforced under the table
-- ---------------------------------------------------------------------------

create or replace function public.task_submissions_window()
returns trigger
language plpgsql
as $$
declare
  t record;
begin
  -- `for share` holds the task row until this insert commits, so a concurrent
  -- cancel or finalise waits for it, and an entry waiting on one of those reads
  -- the decided status rather than the one before it.
  select status, ends_at into t
  from public.tasks
  where id = new.task_id
  for share;

  if not found then
    raise exception 'task % does not exist', new.task_id;
  end if;

  if t.status <> 'live' then
    raise exception 'task is % and is not accepting entries', t.status
      using errcode = 'FZ100';
  end if;

  if t.ends_at <= now() then
    raise exception 'task closed at % and is not accepting entries', t.ends_at
      using errcode = 'FZ100';
  end if;

  return new;
end
$$;

drop trigger if exists task_submissions_window_check on public.task_submissions;
create trigger task_submissions_window_check
  before insert on public.task_submissions
  for each row
  execute function public.task_submissions_window();

comment on function public.task_submissions_window() is
  'Refuses an entry once a task is closed or no longer live. Raises FZ100 so a route can tell it apart from a real failure.';

-- ---------------------------------------------------------------------------
-- 6. Winners
-- ---------------------------------------------------------------------------

create table if not exists public.task_winners (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  submission_id uuid not null references public.task_submissions (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  place integer not null,
  reward_note text not null default '',
  selected_at timestamptz not null default now(),
  notified_at timestamptz,
  constraint task_winners_submission_unique unique (submission_id),
  constraint task_winners_place_unique unique (task_id, place),
  constraint task_winners_place_check check (place >= 1)
);

create index if not exists task_winners_task_idx on public.task_winners (task_id, place);
create index if not exists task_winners_account_idx on public.task_winners (account_id);

comment on table public.task_winners is
  'Public once the task is completed: the winning entries are the useful record of what actually won.';
comment on column public.task_winners.notified_at is
  'Set after the win has been announced, so a retry cannot tell somebody twice.';

-- ---------------------------------------------------------------------------
-- 7. Length bounds
--
-- The same limits web/lib/tasks.ts enforces, held under the tables so a writer
-- that skips the application cannot store an unbounded value on a public page.
-- Dropped and re-added so a re-run leaves exactly one of each.
-- ---------------------------------------------------------------------------

alter table public.projects drop constraint if exists projects_name_len;
alter table public.projects
  add constraint projects_name_len check (char_length(btrim(name)) between 2 and 60);

alter table public.tasks drop constraint if exists tasks_description_len;
alter table public.tasks
  add constraint tasks_description_len check (char_length(description) <= 8000);

alter table public.tasks drop constraint if exists tasks_reward_display_len;
alter table public.tasks
  add constraint tasks_reward_display_len check (char_length(reward_display) <= 120);

alter table public.task_requirements drop constraint if exists task_requirements_label_len;
alter table public.task_requirements
  add constraint task_requirements_label_len check (char_length(label) <= 200);

alter table public.task_links drop constraint if exists task_links_label_len;
alter table public.task_links
  add constraint task_links_label_len check (char_length(label) <= 80);

alter table public.task_links drop constraint if exists task_links_url_len;
alter table public.task_links
  add constraint task_links_url_len check (char_length(url) <= 2000);

alter table public.task_submissions drop constraint if exists task_submissions_content_text_len;
alter table public.task_submissions
  add constraint task_submissions_content_text_len check (char_length(content_text) <= 4000);

alter table public.task_submissions drop constraint if exists task_submissions_content_url_len;
alter table public.task_submissions
  add constraint task_submissions_content_url_len check (char_length(content_url) <= 2000);

alter table public.task_winners drop constraint if exists task_winners_reward_note_len;
alter table public.task_winners
  add constraint task_winners_reward_note_len check (char_length(reward_note) <= 120);

-- ---------------------------------------------------------------------------
-- 8. Usernames and project handles are one namespace
--
-- A project at /project/alice and a person @alice would be two identities
-- behind one name. Each side refuses a name the other already holds, with
-- FZ101 so the application can tell it apart from a real failure.
--
-- Both functions take the same transaction-scoped advisory lock on the
-- lowercased name before looking, so a username and a handle claimed at the
-- same instant are decided one after the other instead of both passing.
--
-- security definer with a pinned search_path for the reason
-- accounts_enforce_username_not_reserved gives: the lookup must see every row
-- whichever role is writing.
-- ---------------------------------------------------------------------------

create or replace function public.projects_handle_not_username()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('flizy.name:' || lower(new.handle)));

  if exists (
    select 1
    from public.accounts a
    where a.username is not null
      and lower(a.username) = lower(new.handle)
  ) then
    raise exception 'project handle is taken by a username'
      using errcode = 'FZ101';
  end if;

  return new;
end
$$;

drop trigger if exists projects_handle_not_username on public.projects;
create trigger projects_handle_not_username
  before insert or update of handle
  on public.projects
  for each row
  execute function public.projects_handle_not_username();

create or replace function public.accounts_username_not_project_handle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.username is null or btrim(new.username) = '' then
    return new;
  end if;

  -- An update that names the column without changing it is not a new claim.
  if tg_op = 'UPDATE' and lower(new.username) is not distinct from lower(old.username) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('flizy.name:' || lower(new.username)));

  if exists (
    select 1
    from public.projects p
    where lower(p.handle) = lower(new.username)
  ) then
    raise exception 'username is taken by a project handle'
      using errcode = 'FZ101';
  end if;

  return new;
end
$$;

drop trigger if exists accounts_username_not_project_handle on public.accounts;
create trigger accounts_username_not_project_handle
  before insert or update of username
  on public.accounts
  for each row
  execute function public.accounts_username_not_project_handle();

comment on function public.projects_handle_not_username() is
  'Refuses a project handle that is already a username. Raises FZ101.';
comment on function public.accounts_username_not_project_handle() is
  'Refuses a username that is already a project handle. Raises FZ101.';

-- ---------------------------------------------------------------------------
-- 9. Participant counts, aggregated where the rows are
--
-- The public lists show how many people entered each task. Counting in
-- Postgres returns one row per task instead of one row per entry.
-- ---------------------------------------------------------------------------

create or replace function public.task_participant_counts(p_task_ids uuid[])
returns table (task_id uuid, participants bigint)
language sql
stable
set search_path = public, pg_temp
as $$
  select s.task_id, count(*)::bigint
  from public.task_submissions s
  where s.task_id = any(p_task_ids)
  group by s.task_id
$$;

revoke all on function public.task_participant_counts(uuid[]) from public;
revoke all on function public.task_participant_counts(uuid[]) from anon, authenticated;
grant execute on function public.task_participant_counts(uuid[]) to service_role;

comment on function public.task_participant_counts(uuid[]) is
  'Entries per task for the given task ids. Tasks with no entries are absent.';

-- ---------------------------------------------------------------------------
-- 10. Row level security. On, with no policies: every read and write goes
--     through the service role, exactly like every other table here.
-- ---------------------------------------------------------------------------

alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_requirements enable row level security;
alter table public.task_links enable row level security;
alter table public.task_submissions enable row level security;
alter table public.task_winners enable row level security;

revoke all on table public.projects from anon, authenticated;
revoke all on table public.tasks from anon, authenticated;
revoke all on table public.task_requirements from anon, authenticated;
revoke all on table public.task_links from anon, authenticated;
revoke all on table public.task_submissions from anon, authenticated;
revoke all on table public.task_winners from anon, authenticated;

grant all on table public.projects to service_role;
grant all on table public.tasks to service_role;
grant all on table public.task_requirements to service_role;
grant all on table public.task_links to service_role;
grant all on table public.task_submissions to service_role;
grant all on table public.task_winners to service_role;

grant usage, select on sequence public.task_ref_seq to service_role;

-- ---------------------------------------------------------------------------
-- 11. Post-conditions. Invariants that hold whenever this runs, not facts about
--     the moment it first ran, so re-applying the file to fix something later
--     cannot trip over ordinary data.
-- ---------------------------------------------------------------------------

do $$
declare
  bad integer;
begin
  if to_regclass('public.tasks') is null
     or to_regclass('public.task_submissions') is null
     or to_regclass('public.task_winners') is null
     or to_regclass('public.task_requirements') is null
     or to_regclass('public.task_links') is null
     or to_regclass('public.projects') is null then
    raise exception 'a tasks table is missing';
  end if;

  if to_regproc('public.task_submissions_window') is null then
    raise exception 'task_submissions_window is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'task_submissions_window_check' and not tgisinternal
  ) then
    raise exception 'task_submissions_window_check trigger is missing';
  end if;

  -- The two uniqueness rules, one entry per post URL and one per participant,
  -- are what stop duplicate entries, so their absence must fail loudly.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'task_submissions_url_unique_idx'
  ) then
    raise exception 'task_submissions_url_unique_idx is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.task_submissions'::regclass
      and conname = 'task_submissions_one_per_account'
  ) then
    raise exception 'task_submissions_one_per_account is missing';
  end if;

  -- Every length bound in section 7.
  select count(*) into bad
  from unnest(array[
    'projects_name_len', 'tasks_description_len', 'tasks_reward_display_len',
    'task_requirements_label_len', 'task_links_label_len', 'task_links_url_len',
    'task_submissions_content_text_len', 'task_submissions_content_url_len',
    'task_winners_reward_note_len'
  ]) as want(name)
  where not exists (
    select 1 from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'public' and c.conname = want.name
  );
  if bad > 0 then
    raise exception '% length constraint(s) from section 7 are missing', bad;
  end if;

  -- The shared namespace, both directions.
  if to_regproc('public.projects_handle_not_username') is null
     or to_regproc('public.accounts_username_not_project_handle') is null then
    raise exception 'a username/handle namespace function is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'projects_handle_not_username' and not tgisinternal
  ) or not exists (
    select 1 from pg_trigger
    where tgname = 'accounts_username_not_project_handle' and not tgisinternal
  ) then
    raise exception 'a username/handle namespace trigger is missing';
  end if;

  select count(*) into bad
  from public.projects p
  join public.accounts a on lower(a.username) = lower(p.handle);
  if bad > 0 then
    raise exception '% project handle(s) are also a username', bad;
  end if;

  if to_regprocedure('public.task_participant_counts(uuid[])') is null then
    raise exception 'task_participant_counts is missing';
  end if;

  -- No winner may point at an entry from a different task.
  select count(*) into bad
  from public.task_winners w
  join public.task_submissions s on s.id = w.submission_id
  where s.task_id <> w.task_id;
  if bad > 0 then
    raise exception '% winner(s) point at an entry from another task', bad;
  end if;

  -- No task may have more winners than it said it would.
  select count(*) into bad
  from public.tasks t
  where (select count(*) from public.task_winners w where w.task_id = t.id) > t.winners_count;
  if bad > 0 then
    raise exception '% task(s) have more winners than winners_count', bad;
  end if;

  -- Every RLS-protected table here must actually have it on.
  select count(*) into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('projects', 'tasks', 'task_requirements', 'task_links',
                      'task_submissions', 'task_winners')
    and c.relkind = 'r'
    and not c.relrowsecurity;
  if bad > 0 then
    raise exception '% tasks table(s) have row level security off', bad;
  end if;
end
$$;
