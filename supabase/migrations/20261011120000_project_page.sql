-- Project page: a saved banner, a category and a level on each task, and the
-- participant count the page shows.
--
-- 1. projects.banner is the art on the right of the project hero, kept as a
--    data URL like projects.image. The browser shrinks it to 1200x630 first.
-- 2. tasks.category and tasks.level are chosen when a task is created and
--    shown as chips. Tasks created before this stay null and show none.
-- 3. project_participant_stats counts distinct accounts that entered any of a
--    project's tasks, where the rows are, instead of reading every entry.
--
-- Additive only. Re-running is safe.

-- ---------------------------------------------------------------------------
-- 1. Banner
-- ---------------------------------------------------------------------------

alter table public.projects
  add column if not exists banner text;

alter table public.projects drop constraint if exists projects_banner_format;
alter table public.projects
  add constraint projects_banner_format check (
    banner is null
    or (
      char_length(banner) <= 300000
      and banner ~ '^data:image/(webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$'
    )
  );

comment on column public.projects.banner is
  'Project hero banner as a data URL (webp, png or jpeg), at most 300000 characters. Null: a plain glow.';

-- ---------------------------------------------------------------------------
-- 2. Task labels
-- ---------------------------------------------------------------------------

alter table public.tasks
  add column if not exists category text;

alter table public.tasks
  add column if not exists level text;

alter table public.tasks drop constraint if exists tasks_category_check;
alter table public.tasks
  add constraint tasks_category_check
  check (category is null or category in ('social', 'onchain', 'community', 'content'));

alter table public.tasks drop constraint if exists tasks_level_check;
alter table public.tasks
  add constraint tasks_level_check
  check (level is null or level in ('beginner', 'intermediate', 'advanced'));

comment on column public.tasks.category is 'social, onchain, community or content. Null on tasks created before labels.';
comment on column public.tasks.level is 'beginner, intermediate or advanced. Null on tasks created before labels.';

-- ---------------------------------------------------------------------------
-- 3. Participants
-- ---------------------------------------------------------------------------

create or replace function public.project_participant_stats(p_project_id uuid)
returns table (participants bigint)
language sql
stable
set search_path = public, pg_temp
as $$
  select count(distinct s.account_id)::bigint
  from public.task_submissions s
  join public.tasks t on t.id = s.task_id
  where t.project_id = p_project_id
$$;

revoke all on function public.project_participant_stats(uuid) from public;
revoke all on function public.project_participant_stats(uuid) from anon, authenticated;
grant execute on function public.project_participant_stats(uuid) to service_role;

comment on function public.project_participant_stats(uuid) is
  'Distinct accounts that entered any task of the project.';

-- ---------------------------------------------------------------------------
-- Post-conditions: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'banner'
  ) then
    raise exception 'projects.banner is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tasks' and column_name = 'category'
  ) then
    raise exception 'tasks.category is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tasks' and column_name = 'level'
  ) then
    raise exception 'tasks.level is missing';
  end if;

  if to_regprocedure('public.project_participant_stats(uuid)') is null then
    raise exception 'function project_participant_stats is missing';
  end if;
end $$;
