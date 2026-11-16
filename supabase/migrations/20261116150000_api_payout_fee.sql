-- The fee on Flizy Pay API payouts.
--
-- The platform pays it, on top of each payout, in the payout's asset, through
-- its allowance; the recipient always gets the full amount
-- (lib/api/payoutWorker.js). Set only by Flizy (scripts/api-platform.mjs),
-- never through the API.
--
--   api_platforms.payout_fee_mode   'tier'  the person-to-person fee tiers
--                                           (lib/fees.js), the default
--                                   'bps'   fee_bps of each payout
--                                   'none'  no fee
--   api_transactions.fee_amount     the fee charged on a payout, in the same
--                                   base units as amount. null when none.
--
-- Idempotent. A partial apply fails the post-condition.

alter table public.api_platforms add column if not exists payout_fee_mode text not null default 'tier';

alter table public.api_platforms drop constraint if exists api_platforms_payout_fee_mode_check;
alter table public.api_platforms
  add constraint api_platforms_payout_fee_mode_check
  check (payout_fee_mode in ('tier', 'bps', 'none') and (payout_fee_mode <> 'bps' or fee_bps > 0));

alter table public.api_transactions add column if not exists fee_amount text;

alter table public.api_transactions drop constraint if exists api_transactions_fee_amount_check;
alter table public.api_transactions
  add constraint api_transactions_fee_amount_check
  check (fee_amount is null or fee_amount ~ '^[0-9]+$');

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'api_platforms' and column_name = 'payout_fee_mode'
  ) then
    raise exception 'api_platforms.payout_fee_mode is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'api_transactions' and column_name = 'fee_amount'
  ) then
    raise exception 'api_transactions.fee_amount is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'api_platforms_payout_fee_mode_check') then
    raise exception 'api_platforms_payout_fee_mode_check is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'api_transactions_fee_amount_check') then
    raise exception 'api_transactions_fee_amount_check is missing';
  end if;
end
$$;
