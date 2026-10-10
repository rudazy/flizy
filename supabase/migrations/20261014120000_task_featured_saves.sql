-- Tasks: a Featured mark set by a Flizy admin, and tasks an account saved.
--
-- featured_at is written by the admin feature route only. The application
-- checks accounts.is_admin before it writes, and only the service role can
-- write public.tasks, so a creator cannot feature their own task.
--
-- task_saves is a per-account bookmark list. A save points at a task and
-- disappears with it.
--
-- Everything is service-role only.
--
-- Additive only. Re-running is safe.

-- ---------------------------------------------------------------------------
-- 1. Featured
-- ---------------------------------------------------------------------------

alter table public.tasks
  add column if not exists featured_at timestamptz;

comment on column public.tasks.featured_at is
  'When a Flizy admin featured this task. Null: not featured. Featured tasks list first.';

-- ---------------------------------------------------------------------------
-- 2. Saves
-- ---------------------------------------------------------------------------

create table if not exists public.task_saves (
  account_id uuid not null references public.accounts (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (account_id, task_id)
);

create index if not exists task_saves_account_idx
  on public.task_saves (account_id, created_at desc);

comment on table public.task_saves is 'Tasks an account saved to come back to.';

-- ---------------------------------------------------------------------------
-- Access: service role only.
-- ---------------------------------------------------------------------------

alter table public.task_saves enable row level security;

revoke all on table public.task_saves from anon, authenticated;
grant all on table public.task_saves to service_role;

-- ---------------------------------------------------------------------------
-- Post-condition
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tasks'
      and column_name = 'featured_at'
  ) then
    raise exception 'tasks.featured_at is missing';
  end if;

  if to_regclass('public.task_saves') is null then
    raise exception 'public.task_saves is missing';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.task_saves'::regclass) then
    raise exception 'public.task_saves has row level security off';
  end if;
end $$;
