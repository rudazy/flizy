-- A payment request can be refused, and the person who asked gets told.
--
-- Until now a payer had exactly two options: pay, or ignore. Only the requester
-- could end a request, through cancelPaymentRequest, which checks
-- requester_account_id and refuses anybody else. So a request nobody intended
-- to pay stayed 'pending' forever and the asker never learned why.
--
-- That is tolerable for a single request and not tolerable for a split bill.
-- An organiser who splits four ways has no way to discover that one person is
-- out: the bill simply sits half-open, and summarizeBills keeps counting the
-- refused share as still owed.
--
-- 'declined' is deliberately NOT 'cancelled'. They are different events with
-- different actors:
--
--   cancelled  the requester withdrew the ask          (requester acts)
--   declined   the person asked refused to pay it      (recipient acts)
--
-- Collapsing them would make a split's history unreadable -- an organiser
-- looking at four cancelled rows could not tell which they withdrew and which
-- were refused. Both are terminal and neither moves money.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Widen the status
-- ---------------------------------------------------------------------------

-- 20260729100000_claim_processing_status.sql set the current list. Same
-- drop-and-recreate shape, because a check constraint cannot be extended.
alter table public.payment_requests
  drop constraint if exists payment_requests_status_check;

alter table public.payment_requests
  add constraint payment_requests_status_check
  check (status in ('pending', 'processing', 'paid', 'cancelled', 'declined'));

-- ---------------------------------------------------------------------------
-- 2. When it happened
-- ---------------------------------------------------------------------------

-- Mirrors cancelled_at and paid_at. No declined_by column: a request carries
-- exactly one recipient already, so who refused is the person it was addressed
-- to. Storing it again would let the two disagree.
alter table public.payment_requests
  add column if not exists declined_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Post-condition
-- ---------------------------------------------------------------------------

do $$
declare
  ok boolean;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payment_requests'
      and column_name = 'declined_at'
  ) then
    raise exception 'payment_requests.declined_at was not created';
  end if;

  -- Prove the new status is actually accepted rather than trusting that the
  -- constraint was replaced: a stale definition would fail every decline at
  -- runtime instead of here.
  select exists (
    select 1
    from pg_constraint
    where conname = 'payment_requests_status_check'
      and pg_get_constraintdef(oid) like '%declined%'
  ) into ok;

  if not ok then
    raise exception 'payment_requests_status_check does not admit declined';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Documentation
-- ---------------------------------------------------------------------------

comment on column public.payment_requests.declined_at is
  'Set when the person the request was addressed to refused it. Distinct from cancelled_at, which is the requester withdrawing their own ask: different actor, different meaning, and a split bill needs to tell them apart.';
comment on column public.payment_requests.status is
  'pending -> processing -> paid, or a terminal cancelled (requester withdrew) / declined (recipient refused). processing is the row-level lock taken before money moves.';
