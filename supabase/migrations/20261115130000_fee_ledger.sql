-- Payment fees: one row per fee Flizy charged.
--
-- The fee ledger is the record rewards are later calculated from. A row is
-- written once the payment that carried the fee has landed (lib/feeQuote.js,
-- recordFee), unique per source, so a payment retried or reconciled twice is
-- never charged or counted twice. History is never edited: a reversal is a row
-- of its own with kind 'adjustment'.
--
--   source_kind, source_id   what carried the fee: a transfers row, or a claims row
--   kind                     p2p, merchant, swap, api_payout, adjustment
--   asset, fee_units         the fee in the asset charged, in raw units
--   fee_usd_micro            the fee at the price used (micro-USD: USD x 1,000,000)
--   tier_usd_micro           the person-to-person tier for the amount, when one applies
--   gas_est_usd_micro        the gas estimate the fee was decided on
--   absorbed_usd_micro       gas above the tier fee that Flizy paid (counted
--                            against FEE_ABSORB_DAILY_CAP_USD)
--   gas_over_tier            the estimate was above the tier fee (every case is logged)
--   price_usd_micro, price_source, priced_at
--                            the asset price used, where it came from, and when
--   gas_paid_wei, gas_paid_usd_micro, net_usd_micro
--                            the gas Flizy actually paid for that payment and the
--                            fee net of it, once known
--
-- Service role only. Idempotent. A partial apply fails the post-condition.

create table if not exists public.fee_ledger (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null,
  source_id uuid not null,
  account_id uuid,
  tx_hash text,
  kind text not null,
  asset text not null,
  fee_units numeric(78, 0) not null,
  fee_usd_micro bigint not null,
  tier_usd_micro bigint,
  gas_est_usd_micro bigint,
  absorbed_usd_micro bigint not null default 0,
  gas_over_tier boolean not null default false,
  price_usd_micro bigint not null,
  price_source text not null,
  priced_at timestamptz not null,
  gas_paid_wei numeric(78, 0),
  gas_paid_usd_micro bigint,
  net_usd_micro bigint,
  created_at timestamptz not null default now(),
  constraint fee_ledger_source_kind_check check (source_kind in ('transfer', 'claim')),
  constraint fee_ledger_kind_check check (kind in ('p2p', 'merchant', 'swap', 'api_payout', 'adjustment')),
  constraint fee_ledger_asset_check check (asset ~ '^[A-Z][A-Z0-9]{0,11}$'),
  constraint fee_ledger_amounts_check check (
    fee_units >= 0 and fee_usd_micro >= 0 and absorbed_usd_micro >= 0 and price_usd_micro > 0
    and (tier_usd_micro is null or tier_usd_micro >= 0)
    and (gas_est_usd_micro is null or gas_est_usd_micro >= 0)
    and (gas_paid_wei is null or gas_paid_wei >= 0)
  ),
  constraint fee_ledger_hash_check check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  constraint fee_ledger_price_source_check check (char_length(price_source) between 1 and 40),
  constraint fee_ledger_source_unique unique (source_kind, source_id, kind)
);

create index if not exists fee_ledger_created_idx on public.fee_ledger (created_at desc);
create index if not exists fee_ledger_account_idx on public.fee_ledger (account_id, created_at desc);

comment on table public.fee_ledger is
  'Payment fees Flizy charged, one row per source and kind, never edited. The record rewards are calculated from.';

alter table public.fee_ledger enable row level security;
revoke all on table public.fee_ledger from public, anon, authenticated;
grant all on table public.fee_ledger to service_role;

do $$
begin
  if not exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'fee_ledger'
  ) then
    raise exception 'fee_ledger is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fee_ledger_source_unique') then
    raise exception 'fee_ledger_source_unique is missing';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'fee_ledger_created_idx') then
    raise exception 'fee_ledger_created_idx is missing';
  end if;
  if (select relrowsecurity from pg_class where oid = 'public.fee_ledger'::regclass) is not true then
    raise exception 'fee_ledger has no row level security';
  end if;
end $$;
