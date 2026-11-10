-- Traction metrics: what the private dashboard (web/app/dashboard/admin/traction)
-- needs that the schema did not hold.
--
-- 1. metrics_excluded_accounts: the owner's, team and test accounts, so every
--    metric can be shown with and without them. Seeded with the admin accounts
--    and @ludarep, the starter-pack host.
-- 2. metrics_incentive_wallets: wallets whose incoming payments are an
--    incentive, not organic use. Seeded with the starter-pack host's wallet:
--    every new account is asked to pay it first (web/lib/starterHost.ts).
-- 3. incentive_tag on transfers and claims, going forward only. Rows that
--    exist when this runs keep null and read as "untagged"; history is not
--    rewritten. New rows default to 'organic', and a payment to an incentive
--    wallet is tagged with that wallet's kind by trigger.
-- 4. metrics_weekly_snapshots: the weekly figures as they were computed, so a
--    later change of definition does not change what was reported.
--
-- Every new table: RLS on, no policies, no grants to anon or authenticated, so
-- only the service role reads or writes them.

create table if not exists public.metrics_excluded_accounts (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  reason text not null,
  added_at timestamptz not null default now(),
  constraint metrics_excluded_accounts_reason_check check (reason in ('owner', 'team', 'test', 'ops'))
);

insert into public.metrics_excluded_accounts (account_id, reason)
select id, 'owner' from public.accounts where is_admin = true or username = 'ludarep'
on conflict (account_id) do nothing;

create table if not exists public.metrics_incentive_wallets (
  address text primary key,
  kind text not null,
  note text,
  added_at timestamptz not null default now(),
  constraint metrics_incentive_wallets_address_check check (address ~ '^0x[0-9a-f]{40}$'),
  constraint metrics_incentive_wallets_kind_check check (kind in ('starter', 'system'))
);

insert into public.metrics_incentive_wallets (address, kind, note)
select lower(agent_wallet_address), 'starter', 'starter-pack host @ludarep'
from public.accounts
where username = 'ludarep' and agent_wallet_address ~* '^0x[0-9a-f]{40}$'
on conflict (address) do nothing;

-- Added without a default first, so the rows already there stay null (untagged).
alter table public.transfers add column if not exists incentive_tag text;
alter table public.claims add column if not exists incentive_tag text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transfers_incentive_tag_check') then
    alter table public.transfers
      add constraint transfers_incentive_tag_check check (incentive_tag is null or incentive_tag in ('organic', 'starter', 'system'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'claims_incentive_tag_check') then
    alter table public.claims
      add constraint claims_incentive_tag_check check (incentive_tag is null or incentive_tag in ('organic', 'starter', 'system'));
  end if;
end $$;

alter table public.transfers alter column incentive_tag set default 'organic';
alter table public.claims alter column incentive_tag set default 'organic';

-- A payment to an incentive wallet carries that wallet's kind. Only an
-- organic (default) tag is changed, so a tag a writer set on purpose stands.
create or replace function public.transfers_tag_incentive()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  wallet_kind text;
begin
  if new.incentive_tag is distinct from 'organic' or new.to_address is null then
    return new;
  end if;
  select kind into wallet_kind from public.metrics_incentive_wallets where address = lower(new.to_address);
  if wallet_kind is not null then
    new.incentive_tag := wallet_kind;
  end if;
  return new;
end;
$$;

drop trigger if exists transfers_tag_incentive on public.transfers;
create trigger transfers_tag_incentive
  before insert on public.transfers
  for each row execute function public.transfers_tag_incentive();

create table if not exists public.metrics_weekly_snapshots (
  week_start date not null,
  excluded boolean not null,
  definition_version integer not null,
  metrics jsonb not null,
  computed_at timestamptz not null default now(),
  primary key (week_start, excluded, definition_version),
  constraint metrics_weekly_snapshots_monday_check check (extract(isodow from week_start) = 1)
);

alter table public.metrics_excluded_accounts enable row level security;
alter table public.metrics_incentive_wallets enable row level security;
alter table public.metrics_weekly_snapshots enable row level security;

revoke all on public.metrics_excluded_accounts from anon, authenticated;
revoke all on public.metrics_incentive_wallets from anon, authenticated;
revoke all on public.metrics_weekly_snapshots from anon, authenticated;
revoke all on function public.transfers_tag_incentive() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['metrics_excluded_accounts', 'metrics_incentive_wallets', 'metrics_weekly_snapshots'] loop
    if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = t) then
      raise exception 'traction metrics: table % is missing', t;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'traction metrics: RLS is off on %', t;
    end if;
  end loop;
  foreach t in array array['transfers', 'claims'] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'incentive_tag' and column_default like '''organic''%'
    ) then
      raise exception 'traction metrics: %.incentive_tag or its default is missing', t;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgname = 'transfers_tag_incentive' and not tgisinternal) then
    raise exception 'traction metrics: trigger transfers_tag_incentive is missing';
  end if;
end $$;
