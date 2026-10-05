-- Dollar rules for copy trade. Configuration only.
--
-- A buy is a fixed number of cents. A sell is either the same percentage of
-- the copied position (sell_usd_cents stays 0) or a fixed number of cents.
-- buy_usd_cents of 0 means the rules are not saved yet. A zero market cap is
-- "no bound", on the setup and on a wallet. Null on a wallet means "use the
-- setup". Nothing here watches an address or submits a transaction.
-- Re-running is safe.

alter table public.copy_setups add column if not exists buy_usd_cents bigint not null default 0;
alter table public.copy_setups add column if not exists min_mcap_usd bigint not null default 0;
alter table public.copy_setups add column if not exists max_mcap_usd bigint not null default 0;
alter table public.copy_setups add column if not exists sell_mode text not null default 'percent';
alter table public.copy_setups add column if not exists sell_usd_cents bigint not null default 0;
alter table public.copy_setups add column if not exists max_trade_usd_cents bigint not null default 0;
alter table public.copy_setups add column if not exists max_daily_usd_cents bigint not null default 0;
alter table public.copy_setups add column if not exists max_open_positions integer not null default 0;
alter table public.copy_setups add column if not exists ignore_stablecoins boolean not null default true;
alter table public.copy_setups add column if not exists first_buy_only boolean not null default false;
alter table public.copy_setups add column if not exists skip_liquidity boolean not null default true;
alter table public.copy_setups add column if not exists skip_transfers boolean not null default true;
alter table public.copy_setups add column if not exists skip_failed boolean not null default true;
alter table public.copy_setups add column if not exists cooldown_sec integer not null default 0;
alter table public.copy_setups add column if not exists min_token_age_min integer not null default 0;
alter table public.copy_setups add column if not exists min_liquidity_usd bigint not null default 0;
alter table public.copy_setups add column if not exists max_gas_gwei integer not null default 0;
alter table public.copy_setups add column if not exists wallet_daily_cap integer not null default 0;

alter table public.copy_wallets add column if not exists buy_usd_cents bigint;
alter table public.copy_wallets add column if not exists min_mcap_usd bigint;
alter table public.copy_wallets add column if not exists max_mcap_usd bigint;
alter table public.copy_wallets add column if not exists copy_buys boolean;
alter table public.copy_wallets add column if not exists copy_sells boolean;
alter table public.copy_wallets add column if not exists sell_mode text;
alter table public.copy_wallets add column if not exists sell_usd_cents bigint;

alter table public.copy_setups drop constraint if exists copy_setups_usd_limits_check;
alter table public.copy_setups
  add constraint copy_setups_usd_limits_check check (
    buy_usd_cents = 0
    or (
      buy_usd_cents between 100 and 100000000
      and max_trade_usd_cents between buy_usd_cents and 100000000
      and max_daily_usd_cents between max_trade_usd_cents and 100000000
      and max_open_positions between 1 and 100
      and (
        (sell_mode = 'percent' and sell_usd_cents = 0)
        or (sell_mode = 'fixed' and sell_usd_cents between 100 and max_trade_usd_cents)
      )
    )
  );

alter table public.copy_setups drop constraint if exists copy_setups_mcap_usd_check;
alter table public.copy_setups
  add constraint copy_setups_mcap_usd_check check (
    min_mcap_usd between 0 and 1000000000000
    and max_mcap_usd between 0 and 1000000000000
    and (min_mcap_usd = 0 or max_mcap_usd = 0 or max_mcap_usd >= min_mcap_usd)
  );

alter table public.copy_setups drop constraint if exists copy_setups_sell_mode_check;
alter table public.copy_setups
  add constraint copy_setups_sell_mode_check check (sell_mode in ('percent', 'fixed'));

alter table public.copy_setups drop constraint if exists copy_setups_trade_filters_check;
alter table public.copy_setups
  add constraint copy_setups_trade_filters_check check (
    cooldown_sec between 0 and 86400
    and min_token_age_min between 0 and 525600
    and min_liquidity_usd between 0 and 1000000000000
    and max_gas_gwei between 0 and 100000
    and wallet_daily_cap between 0 and 1000
  );

alter table public.copy_wallets drop constraint if exists copy_wallets_buy_usd_cents_check;
alter table public.copy_wallets
  add constraint copy_wallets_buy_usd_cents_check check (
    buy_usd_cents is null or buy_usd_cents between 100 and 100000000
  );

alter table public.copy_wallets drop constraint if exists copy_wallets_mcap_usd_check;
alter table public.copy_wallets
  add constraint copy_wallets_mcap_usd_check check (
    (min_mcap_usd is null or min_mcap_usd between 0 and 1000000000000)
    and (max_mcap_usd is null or max_mcap_usd between 0 and 1000000000000)
    and (
      min_mcap_usd is null
      or max_mcap_usd is null
      or min_mcap_usd = 0
      or max_mcap_usd = 0
      or max_mcap_usd >= min_mcap_usd
    )
  );

alter table public.copy_wallets drop constraint if exists copy_wallets_sell_mode_check;
alter table public.copy_wallets
  add constraint copy_wallets_sell_mode_check check (
    sell_mode is null or sell_mode in ('percent', 'fixed')
  );

alter table public.copy_wallets drop constraint if exists copy_wallets_sell_usd_cents_check;
alter table public.copy_wallets
  add constraint copy_wallets_sell_usd_cents_check check (
    (sell_usd_cents is null or sell_usd_cents between 100 and 100000000)
    and (sell_mode is distinct from 'fixed' or sell_usd_cents >= 100)
    and (sell_mode is distinct from 'percent' or sell_usd_cents is null)
  );

comment on column public.copy_setups.buy_usd_cents is
  'Cents to spend when a followed wallet buys. 0 means trade rules are not saved. Configuration only.';
comment on column public.copy_setups.max_daily_usd_cents is
  'Cents the account may spend on copied buys in a day. The per-trade maximum cannot exceed it.';
comment on column public.copy_wallets.buy_usd_cents is
  'Null uses the setup amount. A number is this wallet only.';
comment on column public.copy_wallets.min_mcap_usd is
  'Null uses the setup. 0 means this wallet has no minimum.';

do $$
declare
  col text;
  setup_cols text[] := array[
    'buy_usd_cents', 'min_mcap_usd', 'max_mcap_usd', 'sell_mode', 'sell_usd_cents',
    'max_trade_usd_cents', 'max_daily_usd_cents', 'max_open_positions',
    'ignore_stablecoins', 'first_buy_only', 'skip_liquidity', 'skip_transfers',
    'skip_failed', 'cooldown_sec', 'min_token_age_min', 'min_liquidity_usd',
    'max_gas_gwei', 'wallet_daily_cap'
  ];
  wallet_cols text[] := array[
    'buy_usd_cents', 'min_mcap_usd', 'max_mcap_usd', 'copy_buys', 'copy_sells',
    'sell_mode', 'sell_usd_cents'
  ];
begin
  foreach col in array setup_cols loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'copy_setups' and column_name = col
    ) then
      raise exception 'copy_setups.% is missing', col;
    end if;
  end loop;

  foreach col in array wallet_cols loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'copy_wallets' and column_name = col
    ) then
      raise exception 'copy_wallets.% is missing', col;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.copy_setups'::regclass and conname = 'copy_setups_usd_limits_check'
  ) then
    raise exception 'copy_setups_usd_limits_check is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.copy_setups'::regclass and conname = 'copy_setups_mcap_usd_check'
  ) then
    raise exception 'copy_setups_mcap_usd_check is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.copy_setups'::regclass and conname = 'copy_setups_sell_mode_check'
  ) then
    raise exception 'copy_setups_sell_mode_check is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.copy_setups'::regclass and conname = 'copy_setups_trade_filters_check'
  ) then
    raise exception 'copy_setups_trade_filters_check is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.copy_wallets'::regclass and conname = 'copy_wallets_buy_usd_cents_check'
  ) then
    raise exception 'copy_wallets_buy_usd_cents_check is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.copy_wallets'::regclass and conname = 'copy_wallets_mcap_usd_check'
  ) then
    raise exception 'copy_wallets_mcap_usd_check is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.copy_wallets'::regclass and conname = 'copy_wallets_sell_mode_check'
  ) then
    raise exception 'copy_wallets_sell_mode_check is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.copy_wallets'::regclass and conname = 'copy_wallets_sell_usd_cents_check'
  ) then
    raise exception 'copy_wallets_sell_usd_cents_check is missing';
  end if;
end
$$;
