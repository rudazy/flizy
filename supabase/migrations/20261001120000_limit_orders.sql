-- Limit orders on the ETH/FLZ pool.
--
-- An order is a standing instruction placed with the account password: swap
-- amount_in when the pool would return at least min_out. The bot's watcher
-- (lib/limitOrders.js) checks open orders, claims one by moving it from open to
-- filling, and swaps with min_out as the on-chain minimum, so a fill can never
-- land below the price the person set.
--
-- Amounts are wei as text. A numeric column reaches the app as a JSON number
-- and loses precision above 2^53; text keeps every digit.
--
-- Re-running is safe.

create table if not exists public.limit_orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  side text not null,
  amount_in text not null,
  min_out text not null,
  status text not null default 'open',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  filled_at timestamptz,
  tx_hash text,
  error text
);

alter table public.limit_orders drop constraint if exists limit_orders_side_check;
alter table public.limit_orders
  add constraint limit_orders_side_check check (side in ('buy', 'sell'));

alter table public.limit_orders drop constraint if exists limit_orders_amount_in_check;
alter table public.limit_orders
  add constraint limit_orders_amount_in_check check (amount_in ~ '^[1-9][0-9]{0,77}$');

alter table public.limit_orders drop constraint if exists limit_orders_min_out_check;
alter table public.limit_orders
  add constraint limit_orders_min_out_check check (min_out ~ '^[1-9][0-9]{0,77}$');

alter table public.limit_orders drop constraint if exists limit_orders_status_check;
alter table public.limit_orders
  add constraint limit_orders_status_check
  check (status in ('open', 'filling', 'filled', 'cancelled', 'expired', 'failed'));

-- Seven days is the longest an order may stand. A minute of slack for the
-- clock difference between the app and the database.
alter table public.limit_orders drop constraint if exists limit_orders_expiry_check;
alter table public.limit_orders
  add constraint limit_orders_expiry_check
  check (expires_at > created_at and expires_at <= created_at + interval '7 days 1 minute');

alter table public.limit_orders drop constraint if exists limit_orders_tx_hash_check;
alter table public.limit_orders
  add constraint limit_orders_tx_hash_check check (tx_hash is null or tx_hash ~ '^0x[0-9a-fA-F]{64}$');

alter table public.limit_orders drop constraint if exists limit_orders_error_check;
alter table public.limit_orders
  add constraint limit_orders_error_check check (error is null or char_length(error) <= 300);

-- The watcher's scan: open orders by deadline.
create index if not exists limit_orders_open_idx
  on public.limit_orders (expires_at)
  where status = 'open';

-- The account's own list, newest first.
create index if not exists limit_orders_account_idx
  on public.limit_orders (account_id, created_at desc);

-- At most 10 open orders per account, and 30 placed per hour so placing and
-- cancelling in a loop cannot grow the table without bound. Enforced here,
-- under a lock per account, because a count the app takes before inserting
-- lets two parallel requests both pass it.
create or replace function public.limit_orders_before_insert()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  open_count integer;
  recent integer;
begin
  perform pg_advisory_xact_lock(hashtext('limit_orders:' || new.account_id::text));

  select count(*) into open_count
  from public.limit_orders
  where account_id = new.account_id and status in ('open', 'filling');
  if open_count >= 10 then
    raise exception 'limit_orders_cap' using errcode = 'check_violation';
  end if;

  select count(*) into recent
  from public.limit_orders
  where account_id = new.account_id and created_at > now() - interval '1 hour';
  if recent >= 30 then
    raise exception 'limit_orders_rate' using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

drop trigger if exists limit_orders_before_insert on public.limit_orders;
create trigger limit_orders_before_insert
  before insert on public.limit_orders
  for each row execute function public.limit_orders_before_insert();

comment on table public.limit_orders is
  'ETH/FLZ limit orders. Filled by the bot watcher with min_out as the on-chain minimum.';

alter table public.limit_orders enable row level security;

revoke all on table public.limit_orders from anon, authenticated;

grant all on table public.limit_orders to service_role;

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'limit_orders'
  ) then
    raise exception 'limit_orders is missing';
  end if;

  if (
    select count(*) from pg_constraint
    where conrelid = 'public.limit_orders'::regclass
      and conname in (
        'limit_orders_side_check',
        'limit_orders_amount_in_check',
        'limit_orders_min_out_check',
        'limit_orders_status_check',
        'limit_orders_expiry_check',
        'limit_orders_tx_hash_check',
        'limit_orders_error_check'
      )
  ) <> 7 then
    raise exception 'limit_orders constraints are incomplete';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'limit_orders_before_insert'
      and tgrelid = 'public.limit_orders'::regclass
  ) then
    raise exception 'limit_orders_before_insert trigger is missing';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'limit_orders' and c.relrowsecurity
  ) then
    raise exception 'limit_orders row level security is off';
  end if;
end;
$$;
