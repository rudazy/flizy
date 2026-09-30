-- Copy Trade and Copy Mint configuration.
--
-- Wallets and limits only. Nothing in this schema submits a transaction or
-- watches an address. Re-running is safe.

create table if not exists public.copy_setups (
  account_id uuid not null references public.accounts (id) on delete cascade,
  kind text not null,
  allocation_wei text not null default '0',
  per_trade_wei text not null default '0',
  max_trade_wei text not null default '0',
  max_daily_wei text not null default '0',
  max_daily_count integer not null default 0,
  copy_buys boolean not null default true,
  copy_sells boolean not null default false,
  slippage_bps integer not null default 100,
  updated_at timestamptz not null default now(),
  primary key (account_id, kind)
);

create table if not exists public.copy_wallets (
  account_id uuid not null references public.accounts (id) on delete cascade,
  kind text not null,
  address text not null,
  label text not null,
  enabled boolean not null default true,
  position integer not null,
  primary key (account_id, kind, address)
);

create index if not exists copy_wallets_account_idx
  on public.copy_wallets (account_id, kind, position);

alter table public.copy_setups drop constraint if exists copy_setups_kind_check;
alter table public.copy_setups
  add constraint copy_setups_kind_check check (kind in ('trade', 'mint'));

alter table public.copy_setups drop constraint if exists copy_setups_allocation_wei_check;
alter table public.copy_setups
  add constraint copy_setups_allocation_wei_check check (allocation_wei ~ '^[0-9]{1,78}$');

alter table public.copy_setups drop constraint if exists copy_setups_per_trade_wei_check;
alter table public.copy_setups
  add constraint copy_setups_per_trade_wei_check check (per_trade_wei ~ '^[0-9]{1,78}$');

alter table public.copy_setups drop constraint if exists copy_setups_max_trade_wei_check;
alter table public.copy_setups
  add constraint copy_setups_max_trade_wei_check check (max_trade_wei ~ '^[0-9]{1,78}$');

alter table public.copy_setups drop constraint if exists copy_setups_max_daily_wei_check;
alter table public.copy_setups
  add constraint copy_setups_max_daily_wei_check check (max_daily_wei ~ '^[0-9]{1,78}$');

alter table public.copy_setups drop constraint if exists copy_setups_count_check;
alter table public.copy_setups
  add constraint copy_setups_count_check check (max_daily_count between 0 and 50);

alter table public.copy_setups drop constraint if exists copy_setups_slippage_check;
alter table public.copy_setups
  add constraint copy_setups_slippage_check check (slippage_bps between 10 and 1000);

alter table public.copy_setups drop constraint if exists copy_setups_bounds_check;
alter table public.copy_setups
  add constraint copy_setups_bounds_check check (
    per_trade_wei::numeric <= allocation_wei::numeric
    and max_trade_wei::numeric <= allocation_wei::numeric
    and max_daily_wei::numeric <= allocation_wei::numeric
  );

alter table public.copy_wallets drop constraint if exists copy_wallets_kind_check;
alter table public.copy_wallets
  add constraint copy_wallets_kind_check check (kind in ('trade', 'mint'));

alter table public.copy_wallets drop constraint if exists copy_wallets_position_check;
alter table public.copy_wallets
  add constraint copy_wallets_position_check check (position between 1 and 100);

alter table public.copy_wallets drop constraint if exists copy_wallets_address_check;
alter table public.copy_wallets
  add constraint copy_wallets_address_check check (address ~ '^0x[0-9a-fA-F]{40}$');

alter table public.copy_wallets drop constraint if exists copy_wallets_label_check;
alter table public.copy_wallets
  add constraint copy_wallets_label_check check (char_length(label) between 1 and 32);

comment on table public.copy_setups is
  'Per-account limits for copy trade and copy mint. Configuration only.';
comment on table public.copy_wallets is
  'Wallets a person chose to follow. enabled false keeps the row.';

alter table public.copy_setups enable row level security;
alter table public.copy_wallets enable row level security;

revoke all on table public.copy_setups from anon, authenticated;
revoke all on table public.copy_wallets from anon, authenticated;

grant all on table public.copy_setups to service_role;
grant all on table public.copy_wallets to service_role;

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'copy_setups'
  ) then
    raise exception 'copy_setups is missing';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'copy_wallets'
  ) then
    raise exception 'copy_wallets is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'copy_setups_bounds_check'
  ) then
    raise exception 'copy_setups_bounds_check is missing';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'copy_setups' and c.relrowsecurity
  ) then
    raise exception 'copy_setups row level security is off';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'copy_wallets' and c.relrowsecurity
  ) then
    raise exception 'copy_wallets row level security is off';
  end if;
end
$$;
