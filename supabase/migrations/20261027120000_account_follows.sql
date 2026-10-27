-- Follows between Flizy accounts.
--
-- One row is one follow. The primary key is the pair, so a second insert
-- cannot create a second follow. A person cannot follow themselves.
-- alerts is that person's choice for this follow. It is not a payment and
-- it does not open a chat.
--
-- profile_show_social and profile_show_stats let the account hide follower
-- lists and trading figures on the public profile. Both start on, matching
-- the account screen. The owner still sees their own figures.
--
-- Only the service role touches account_follows, through the follow routes,
-- which take the account from the session cookie. Re-running is safe.

alter table public.accounts
  add column if not exists profile_show_social boolean not null default true;

alter table public.accounts
  add column if not exists profile_show_stats boolean not null default true;

comment on column public.accounts.profile_show_social is
  'When false, other people do not see this account''s follower counts or lists.';

comment on column public.accounts.profile_show_stats is
  'When false, other people do not see this account''s volume, swaps, or recent swaps.';

create table if not exists public.account_follows (
  follower_id uuid not null references public.accounts (id) on delete cascade,
  following_id uuid not null references public.accounts (id) on delete cascade,
  alerts boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id)
);

alter table public.account_follows drop constraint if exists account_follows_not_self;
alter table public.account_follows
  add constraint account_follows_not_self check (follower_id <> following_id);

comment on table public.account_follows is
  'One follow from follower_id to following_id. Duplicate pairs cannot be stored.';

comment on column public.account_follows.alerts is
  'Whether the follower wants activity alerts for this follow. Stored only.';

create index if not exists account_follows_following_idx
  on public.account_follows (following_id, created_at desc);

create index if not exists account_follows_follower_idx
  on public.account_follows (follower_id, created_at desc);

-- At most 1000 follows per account, counted under a per-account lock so two
-- parallel inserts cannot both pass the count.
create or replace function public.account_follows_before_insert()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  held integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('account_follows:' || new.follower_id::text, 0));
  select count(*) into held from public.account_follows where follower_id = new.follower_id;
  if held >= 1000 then
    raise exception 'account_follows_cap' using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

drop trigger if exists account_follows_before_insert on public.account_follows;
create trigger account_follows_before_insert
  before insert on public.account_follows
  for each row execute function public.account_follows_before_insert();

-- The insert runs as service_role. The browser roles must not be able to call
-- the counter. Grant that role first so the revoke cannot lock it out.
grant execute on function public.account_follows_before_insert() to service_role;
revoke all on function public.account_follows_before_insert() from public;
revoke all on function public.account_follows_before_insert() from anon, authenticated;

alter table public.account_follows enable row level security;

revoke all on table public.account_follows from anon, authenticated;

grant all on table public.account_follows to service_role;

do $$
begin
  if to_regclass('public.account_follows') is null then
    raise exception 'account_follows is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.account_follows'::regclass
      and conname = 'account_follows_not_self'
  ) then
    raise exception 'account_follows_not_self is missing';
  end if;

  if to_regprocedure('public.account_follows_before_insert()') is null then
    raise exception 'account_follows_before_insert() is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'account_follows_before_insert'
      and tgrelid = 'public.account_follows'::regclass
  ) then
    raise exception 'account_follows_before_insert trigger is missing';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'account_follows' and c.relrowsecurity
  ) then
    raise exception 'account_follows row level security is off';
  end if;

  if (
    select count(*) from information_schema.columns
    where table_schema = 'public'
      and table_name = 'accounts'
      and column_name in ('profile_show_social', 'profile_show_stats')
  ) <> 2 then
    raise exception 'profile visibility columns are missing';
  end if;

  if has_function_privilege('anon', 'public.account_follows_before_insert()', 'execute')
     or has_function_privilege('authenticated', 'public.account_follows_before_insert()', 'execute') then
    raise exception 'account_follows_before_insert is executable by a browser role';
  end if;
end;
$$;
