-- Reference prices for swaps and liquidity changes that skip the PIN.
--
-- A swap between ETH and a verified token keeps the value in the account, so
-- it needs no PIN when its price is fair. "Fair" is measured against these
-- rows, not against the pool alone, because a stolen session could move the
-- pool first and then fire the owner's swap into the moved price.
--
-- The WhatsApp process (lib/priceSnapshots.js) writes one row per verified
-- pool per 15 minute bucket: the pool's reserves at that moment, in raw units
-- (wei of ETH, smallest token units). The reference is the median of the
-- newest four (lib/priceReference.js, web/lib/priceReference.ts). Rows older
-- than two days are deleted by the same process.
--
-- token and pair are stored lower case. One row per (chain, token, bucket):
-- a second writer or a restart cannot add a second snapshot to a bucket.
--
-- Reachable by service_role only, like every table in public.
--
-- Idempotent: safe to run twice.

create table if not exists public.token_price_snapshots (
  id bigserial primary key,
  chain_id integer not null,
  token text not null,
  pair text not null,
  bucket timestamptz not null,
  reserve_eth numeric(78, 0) not null,
  reserve_token numeric(78, 0) not null,
  created_at timestamptz not null default now(),
  constraint token_price_snapshots_token_check check (token ~ '^0x[0-9a-f]{40}$'),
  constraint token_price_snapshots_pair_check check (pair ~ '^0x[0-9a-f]{40}$'),
  constraint token_price_snapshots_reserves_check check (reserve_eth > 0 and reserve_token > 0),
  constraint token_price_snapshots_bucket_key unique (chain_id, token, bucket)
);

comment on table public.token_price_snapshots is
  'One reserves snapshot per verified pool per 15 minute bucket. The median of the newest four is the reference price for PIN-free swaps.';

alter table public.token_price_snapshots enable row level security;
revoke all on table public.token_price_snapshots from public, anon, authenticated;
grant all on table public.token_price_snapshots to service_role;
grant usage, select on sequence public.token_price_snapshots_id_seq to service_role;

do $$
begin
  if to_regclass('public.token_price_snapshots') is null then
    raise exception 'token_price_snapshots is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'token_price_snapshots_bucket_key'
      and conrelid = 'public.token_price_snapshots'::regclass
  ) then
    raise exception 'token_price_snapshots_bucket_key is missing';
  end if;

  if has_table_privilege('anon', 'public.token_price_snapshots', 'select') then
    raise exception 'token_price_snapshots is readable by anon';
  end if;

  if has_table_privilege('authenticated', 'public.token_price_snapshots', 'select') then
    raise exception 'token_price_snapshots is readable by authenticated';
  end if;
end
$$;
