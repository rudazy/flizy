-- Payment requests name an asset and say what they are for.
--
-- "request 50 tusd from @ada for design work" was not expressible: every
-- request was ETH and carried no reason. A request is the one payment the
-- payer did not start, so the reason matters most here.
--
-- 1. asset: ETH, FLZ or TUSD, the assets chat can send. Every existing row is
--    ETH. amount_eth keeps its name and, as on claims, holds the human
--    decimal amount of whichever asset the row is for.
-- 2. note: what the request is for, as the requester typed it. Shown to the
--    payer in the notice, the menu and the transfer plan. Attacker-controlled
--    text: render through displaySafeLabel. Capped at 80 characters, the
--    length the plan preview shows.
--
-- Service role only, like every table in public. Idempotent: safe to run twice.

alter table public.payment_requests
  add column if not exists asset text not null default 'ETH',
  add column if not exists note text;

alter table public.payment_requests drop constraint if exists payment_requests_asset_check;
alter table public.payment_requests
  add constraint payment_requests_asset_check check (asset in ('ETH', 'FLZ', 'TUSD'));

alter table public.payment_requests drop constraint if exists payment_requests_note_len;
alter table public.payment_requests
  add constraint payment_requests_note_len check (note is null or char_length(note) between 1 and 80);

comment on column public.payment_requests.asset is
  'ETH, FLZ or TUSD. amount_eth and paid_amount_eth are human decimals of this asset.';
comment on column public.payment_requests.note is
  'What the request is for, as the requester typed it. Attacker-controlled text: render through displaySafeLabel.';

-- ---------------------------------------------------------------------------
-- Post-conditions: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_requests' and column_name = 'asset'
  ) then
    raise exception 'payment_requests.asset is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_requests' and column_name = 'note'
  ) then
    raise exception 'payment_requests.note is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_requests_asset_check') then
    raise exception 'payment_requests_asset_check is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_requests_note_len') then
    raise exception 'payment_requests_note_len is missing';
  end if;
end
$$;
