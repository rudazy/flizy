-- Ammora as a second swap venue on GIWA Sepolia (testnet).
--
--   ammora_pools       Ammora pools discovered from the chain by the WhatsApp
--                      bot (discoverAmmoraPools over the pinned factory's
--                      logs). The SDK's route client accepts only pools with
--                      this provenance, and the discovery scan is too slow
--                      for a site request, so the bot persists it and the
--                      site reads it. Token name, symbol and decimals are read
--                      from the token contract, never from a metadata URL,
--                      and are attacker-chosen text: they are capped here and
--                      sanitized on every render. tradable is the bot's last
--                      probe quote; every real quote checks again.
--   ammora_scan_state  How far discovery has scanned, so it resumes instead
--                      of rescanning from the factory's start block.
--   transfers.venue    Which venue a swap ran on: null for Flizy's own pools,
--                      'ammora' for Ammora.
--
-- Reachable by service_role only, like every table in public.
--
-- Idempotent: safe to run twice.

create table if not exists public.ammora_pools (
  pool text primary key,
  chain_id integer not null,
  model text not null,
  base_token text not null,
  quote_token text not null,
  factory text not null,
  factory_id text not null,
  creation_block bigint not null,
  creation_tx text not null,
  creation_log_index integer not null,
  runtime_code_hash text not null,
  verified_at_block bigint not null,
  token_name text,
  token_symbol text,
  token_decimals integer,
  launch_status text,
  tradable boolean not null default false,
  tradable_checked_at timestamptz,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ammora_pools_pool_check check (pool ~ '^0x[0-9a-f]{40}$'),
  constraint ammora_pools_base_check check (base_token ~ '^0x[0-9a-f]{40}$'),
  constraint ammora_pools_quote_check check (quote_token ~ '^0x[0-9a-f]{40}$'),
  constraint ammora_pools_model_check check (model in ('dbc', 'concentrated', 'compounding', 'almm')),
  constraint ammora_pools_name_check check (token_name is null or length(token_name) <= 64),
  constraint ammora_pools_symbol_check check (token_symbol is null or length(token_symbol) <= 32),
  constraint ammora_pools_decimals_check check (token_decimals is null or token_decimals between 0 and 36),
  constraint ammora_pools_status_check
    check (launch_status is null or launch_status in ('PENDING', 'ACTIVE', 'MIGRATION_READY', 'MIGRATED', 'FLAGGED'))
);

create index if not exists ammora_pools_base_token_idx on public.ammora_pools (base_token);

drop trigger if exists ammora_pools_set_updated_at on public.ammora_pools;
create trigger ammora_pools_set_updated_at
  before update on public.ammora_pools
  for each row
  execute function public.set_updated_at();

comment on table public.ammora_pools is
  'Ammora pools discovered from the chain by the bot, with token fields read from the token contract. Read by the site to quote Ammora swaps.';

alter table public.ammora_pools enable row level security;
revoke all on table public.ammora_pools from public, anon, authenticated;
grant all on table public.ammora_pools to service_role;

create table if not exists public.ammora_scan_state (
  chain_id integer primary key,
  scanned_to_block bigint not null,
  updated_at timestamptz not null default now()
);

comment on table public.ammora_scan_state is
  'Highest block Ammora pool discovery has scanned, per chain.';

alter table public.ammora_scan_state enable row level security;
revoke all on table public.ammora_scan_state from public, anon, authenticated;
grant all on table public.ammora_scan_state to service_role;

alter table public.transfers
  add column if not exists venue text;

alter table public.transfers
  drop constraint if exists transfers_venue_check;
alter table public.transfers
  add constraint transfers_venue_check check (venue is null or venue in ('ammora'));

comment on column public.transfers.venue is
  'Swap venue: null for Flizy pools, ammora for Ammora.';

do $$
begin
  if to_regclass('public.ammora_pools') is null then
    raise exception 'ammora_pools is missing';
  end if;
  if to_regclass('public.ammora_scan_state') is null then
    raise exception 'ammora_scan_state is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'transfers' and column_name = 'venue'
  ) then
    raise exception 'transfers.venue is missing';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'ammora_pools_set_updated_at'
      and tgrelid = 'public.ammora_pools'::regclass
      and not tgisinternal
  ) then
    raise exception 'ammora_pools_set_updated_at trigger is missing';
  end if;
  if has_table_privilege('anon', 'public.ammora_pools', 'select')
     or has_table_privilege('authenticated', 'public.ammora_pools', 'select')
     or has_table_privilege('anon', 'public.ammora_scan_state', 'select')
     or has_table_privilege('authenticated', 'public.ammora_scan_state', 'select') then
    raise exception 'ammora tables are readable by anon or authenticated';
  end if;
end
$$;
