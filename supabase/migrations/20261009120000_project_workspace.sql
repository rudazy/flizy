-- Project workspace: a saved picture, members, XP on project tasks, and a cap
-- of five live tasks per project.
--
-- 1. projects.image holds the project picture as a data URL. The browser
--    shrinks it to 256x256 before upload, so it stays small enough to keep in
--    the row: no storage bucket, and the image policy already allows data:.
-- 2. project_members lists accounts the owner added. A member may publish
--    tasks for the project and edit its details; only the owner adds or
--    removes members. The owner is not a row here: projects.owner_account_id
--    stays the authority.
-- 3. tasks.xp_reward is what each winner of a project task earns.
--    task_winners.xp is what was actually awarded, written once when winners
--    are saved, so editing a task later cannot rewrite anyone's total.
-- 4. A project has at most five live tasks at once. The application checks
--    first for a readable message; the trigger is the authority, and locks the
--    project row so two members publishing at the same instant are decided one
--    after the other. Raises FZ102.
-- 5. project_xp_leaderboard sums awarded XP per account for one project.
--
-- Additive only. Re-running is safe.

-- ---------------------------------------------------------------------------
-- 1. Picture
-- ---------------------------------------------------------------------------

alter table public.projects
  add column if not exists image text;

alter table public.projects
  add column if not exists updated_at timestamptz;

alter table public.projects drop constraint if exists projects_image_format;
alter table public.projects
  add constraint projects_image_format check (
    image is null
    or (
      char_length(image) <= 200000
      and image ~ '^data:image/(webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$'
    )
  );

comment on column public.projects.image is
  'Project picture as a data URL (webp, png or jpeg), at most 200000 characters. Null: the letter mark.';
comment on column public.projects.updated_at is
  'Last edit of the project details by the owner or a member.';

-- ---------------------------------------------------------------------------
-- 2. Members
-- ---------------------------------------------------------------------------

create table if not exists public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  added_by uuid references public.accounts (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint project_members_unique unique (project_id, account_id)
);

create index if not exists project_members_account_idx on public.project_members (account_id);

comment on table public.project_members is
  'Accounts that may publish tasks for a project and edit it. The owner is projects.owner_account_id, not a row here.';

alter table public.project_members enable row level security;
revoke all on table public.project_members from anon, authenticated;
grant all on table public.project_members to service_role;

-- ---------------------------------------------------------------------------
-- 3. XP
-- ---------------------------------------------------------------------------

alter table public.tasks
  add column if not exists xp_reward integer;

alter table public.tasks drop constraint if exists tasks_xp_reward_check;
alter table public.tasks
  add constraint tasks_xp_reward_check
  check (xp_reward is null or xp_reward between 1 and 100000);

-- "Project tasks only" is held by the application, not by this check: a
-- project deleted with its owner sets tasks.project_id to null, and a check
-- tying the two together would make that delete fail.
comment on column public.tasks.xp_reward is
  'XP each winner earns. Set on project tasks only. Null: no XP.';

alter table public.task_winners
  add column if not exists xp integer not null default 0;

alter table public.task_winners drop constraint if exists task_winners_xp_check;
alter table public.task_winners
  add constraint task_winners_xp_check check (xp between 0 and 100000);

comment on column public.task_winners.xp is
  'XP awarded for this win, copied from tasks.xp_reward when winners are saved.';

-- ---------------------------------------------------------------------------
-- 4. Five live tasks per project
-- ---------------------------------------------------------------------------

create or replace function public.tasks_project_live_cap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  live_count integer;
begin
  if new.project_id is null then
    return new;
  end if;

  perform 1 from public.projects p where p.id = new.project_id for update;

  select count(*) into live_count
  from public.tasks t
  where t.project_id = new.project_id
    and t.status = 'live'
    and t.ends_at > now();

  if live_count >= 5 then
    raise exception 'project has 5 live tasks'
      using errcode = 'FZ102';
  end if;

  return new;
end
$$;

drop trigger if exists tasks_project_live_cap on public.tasks;
create trigger tasks_project_live_cap
  before insert
  on public.tasks
  for each row
  execute function public.tasks_project_live_cap();

comment on function public.tasks_project_live_cap() is
  'Refuses a sixth live task on one project. Raises FZ102.';

-- ---------------------------------------------------------------------------
-- 5. Leaderboard
-- ---------------------------------------------------------------------------

-- total_xp and earners are the same on every row: all XP the project has
-- awarded and how many accounts earned any. Window sums run before the limit,
-- so they count everyone, not only the rows returned.
create or replace function public.project_xp_leaderboard(p_project_id uuid, p_limit integer)
returns table (account_id uuid, xp bigint, wins bigint, total_xp bigint, earners bigint)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    w.account_id,
    sum(w.xp)::bigint,
    count(*)::bigint,
    (sum(sum(w.xp)) over ())::bigint,
    (count(*) over ())::bigint
  from public.task_winners w
  join public.tasks t on t.id = w.task_id
  where t.project_id = p_project_id
    and w.xp > 0
  group by w.account_id
  order by sum(w.xp) desc, count(*) desc, min(w.selected_at) asc
  limit greatest(1, least(coalesce(p_limit, 50), 100))
$$;

revoke all on function public.project_xp_leaderboard(uuid, integer) from public;
revoke all on function public.project_xp_leaderboard(uuid, integer) from anon, authenticated;
grant execute on function public.project_xp_leaderboard(uuid, integer) to service_role;

comment on function public.project_xp_leaderboard(uuid, integer) is
  'Awarded XP per account for one project, highest first. At most 100 rows.';

-- ---------------------------------------------------------------------------
-- Post-conditions: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'image'
  ) then
    raise exception 'projects.image is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'updated_at'
  ) then
    raise exception 'projects.updated_at is missing';
  end if;

  if to_regclass('public.project_members') is null then
    raise exception 'public.project_members is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tasks' and column_name = 'xp_reward'
  ) then
    raise exception 'tasks.xp_reward is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'task_winners' and column_name = 'xp'
  ) then
    raise exception 'task_winners.xp is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'tasks_project_live_cap' and tgrelid = 'public.tasks'::regclass
  ) then
    raise exception 'trigger tasks_project_live_cap is missing';
  end if;

  if to_regprocedure('public.project_xp_leaderboard(uuid, integer)') is null then
    raise exception 'function project_xp_leaderboard is missing';
  end if;
end $$;
