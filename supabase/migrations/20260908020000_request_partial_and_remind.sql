-- Part-paying a request, and nudging one that has gone quiet.
--
-- Two columns, one migration, because they are the two remaining states a
-- request can be in that the table could not express:
--
--   paid_amount_eth   how much of the ask has actually landed
--   last_reminded_at  when the asker last nudged, so they cannot spam
--
-- WHY PARTIAL PAY IS NOT A NEW STATUS. `status` stays the lifecycle
-- (pending -> processing -> paid | cancelled | declined) and the amount answers
-- "how far along". A 'partly_paid' status would put the same fact in two places
-- and let them disagree: a row could read 'partly_paid' with nothing settled, or
-- 'pending' with most of it covered. The status flips to 'paid' when
-- paid_amount_eth reaches amount_eth and not before, so one number decides it.
--
-- Existing rows: paid_amount_eth defaults to 0, which is true for every pending
-- row. Rows already 'paid' are backfilled to their full amount below, because
-- "paid in full" and "0 of 0.01 settled" would otherwise be indistinguishable
-- for anything reading the number instead of the status.
--
-- WHY REMIND NEEDS A COLUMN. A rate limit that lives in memory resets when the
-- bot restarts, which on this deployment is every pull. The nudge is a message
-- to somebody else's phone, so the limit has to survive a restart or it is not
-- a limit.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.payment_requests
  add column if not exists paid_amount_eth numeric(36, 18) not null default 0,
  add column if not exists last_reminded_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Rules
-- ---------------------------------------------------------------------------

do $$
begin
  -- Never negative, and never more than was asked for. Overpaying a request is
  -- a send, not a payment against this row, and letting it through here would
  -- make "how much is still owed" go negative.
  if not exists (
    select 1 from pg_constraint where conname = 'payment_requests_paid_amount_range_check'
  ) then
    alter table public.payment_requests
      add constraint payment_requests_paid_amount_range_check
      check (paid_amount_eth >= 0 and paid_amount_eth <= amount_eth);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Backfill
-- ---------------------------------------------------------------------------

-- A row that settled before this column existed is fully paid by definition.
update public.payment_requests
set paid_amount_eth = amount_eth
where status = 'paid' and paid_amount_eth = 0;

-- ---------------------------------------------------------------------------
-- 4. Post-condition
-- ---------------------------------------------------------------------------

do $$
declare
  missing text;
  wrong integer;
begin
  select string_agg(t.name, ', ')
  into missing
  from (values ('paid_amount_eth'), ('last_reminded_at')) as t(name)
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payment_requests'
      and column_name = t.name
  );
  if missing is not null then
    raise exception 'payment request columns missing: %', missing;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'payment_requests_paid_amount_range_check'
  ) then
    raise exception 'payment_requests_paid_amount_range_check missing';
  end if;

  -- The backfill is the part that can silently half-apply, so check it rather
  -- than assume it: no settled row may still read as nothing paid.
  select count(*) into wrong
  from public.payment_requests
  where status = 'paid' and paid_amount_eth <> amount_eth;
  if wrong > 0 then
    raise exception 'paid rows with a wrong paid_amount_eth: %', wrong;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Documentation
-- ---------------------------------------------------------------------------

comment on column public.payment_requests.paid_amount_eth is
  'How much of amount_eth has actually settled. Status flips to paid when this reaches amount_eth, so the number decides completion and the status never contradicts it. Backfilled to amount_eth for rows that were paid before this column existed.';
comment on column public.payment_requests.last_reminded_at is
  'When the requester last nudged the payer. Persisted rather than held in memory because the rate limit protects somebody else''s phone and has to survive a bot restart.';
