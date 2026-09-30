-- Contracts a person added so a deposit shows in the wallet.
--
-- A row is not a verification and not a market listing. Re-running is safe.

create table if not exists public.account_tokens (
  account_id uuid not null references public.accounts (id) on delete cascade,
  address text not null,
  symbol text not null,
  decimals integer not null,
  created_at timestamptz not null default now(),
  primary key (account_id, address)
);

alter table public.account_tokens drop constraint if exists account_tokens_address_check;
alter table public.account_tokens
  add constraint account_tokens_address_check check (address ~ '^0x[0-9a-fA-F]{40}$');

alter table public.account_tokens drop constraint if exists account_tokens_symbol_check;
alter table public.account_tokens
  add constraint account_tokens_symbol_check check (symbol ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$');

alter table public.account_tokens drop constraint if exists account_tokens_decimals_check;
alter table public.account_tokens
  add constraint account_tokens_decimals_check check (decimals between 0 and 36);

-- One row per contract per account, whatever the casing. The app always
-- stores the checksummed form; this holds for a direct write as well.
create unique index if not exists account_tokens_account_lower_address_idx
  on public.account_tokens (account_id, lower(address));

-- The 50-token cap and the hourly add limit. Enforced here, under a lock per
-- account, because a count the app takes before inserting lets two parallel
-- requests both pass it. Re-adding a contract already on the list is not a new
-- row and is let through.
create or replace function public.account_tokens_before_insert()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  held integer;
  recent integer;
begin
  perform pg_advisory_xact_lock(hashtext('account_tokens:' || new.account_id::text));

  if exists (
    select 1 from public.account_tokens
    where account_id = new.account_id and lower(address) = lower(new.address)
  ) then
    return new;
  end if;

  select count(*) into held
  from public.account_tokens
  where account_id = new.account_id;
  if held >= 50 then
    raise exception 'account_tokens_cap' using errcode = 'check_violation';
  end if;

  select count(*) into recent
  from public.account_tokens
  where account_id = new.account_id and created_at > now() - interval '1 hour';
  if recent >= 20 then
    raise exception 'account_tokens_rate' using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

drop trigger if exists account_tokens_before_insert on public.account_tokens;
create trigger account_tokens_before_insert
  before insert on public.account_tokens
  for each row execute function public.account_tokens_before_insert();

comment on table public.account_tokens is
  'Contracts a person added so a deposit shows in the wallet. Not a verification.';

alter table public.account_tokens enable row level security;

revoke all on table public.account_tokens from anon, authenticated;

grant all on table public.account_tokens to service_role;

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'account_tokens'
  ) then
    raise exception 'account_tokens is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'account_tokens_address_check'
      and conrelid = 'public.account_tokens'::regclass
  ) then
    raise exception 'account_tokens_address_check is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'account_tokens_symbol_check'
      and conrelid = 'public.account_tokens'::regclass
  ) then
    raise exception 'account_tokens_symbol_check is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'account_tokens_decimals_check'
      and conrelid = 'public.account_tokens'::regclass
  ) then
    raise exception 'account_tokens_decimals_check is missing';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'account_tokens' and c.relrowsecurity
  ) then
    raise exception 'account_tokens row level security is off';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'account_tokens'
      and indexname = 'account_tokens_account_lower_address_idx'
  ) then
    raise exception 'account_tokens_account_lower_address_idx is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'account_tokens_before_insert'
      and tgrelid = 'public.account_tokens'::regclass
      and not tgisinternal
  ) then
    raise exception 'account_tokens_before_insert trigger is missing';
  end if;
end
$$;
