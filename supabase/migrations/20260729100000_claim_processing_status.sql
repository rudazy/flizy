-- In-flight state for claims and payment requests.
--
-- Payout, refund and request settlement used to read a row, check it was still
-- 'pending', and only then move money on-chain. The check and the transfer were
-- not atomic, so the same claim confirmed on two channels at once ran both
-- paths and escrow paid twice for one hold. The surplus came out of other
-- users' pending claim liability in the shared escrow wallet.
--
-- 'processing' is the row-level lock. A worker moves pending -> processing with
-- a conditional update and only touches the chain if it won the row.
--
-- A row left in 'processing' means the process died between submitting a
-- transaction and recording its outcome. That is deliberate: it is an operator
-- signal, not something to auto-retry, because retrying a possibly-submitted
-- transfer is exactly the double send this migration exists to prevent.
--   select * from public.claims where status = 'processing';
--   select * from public.payment_requests where status = 'processing';

alter table public.claims
  drop constraint if exists claims_status_check;

alter table public.claims
  add constraint claims_status_check
  check (status in ('pending', 'processing', 'claimed', 'expired', 'cancelled'));

alter table public.payment_requests
  drop constraint if exists payment_requests_status_check;

alter table public.payment_requests
  add constraint payment_requests_status_check
  check (status in ('pending', 'processing', 'paid', 'cancelled'));

-- Escrow solvency and the daily send cap both count in-flight rows, so those
-- lookups filter on status and want an index on the request side too.
create index if not exists payment_requests_status_idx
  on public.payment_requests (status);

comment on column public.claims.status is
  'pending -> processing (row won by one worker) -> claimed or cancelled. processing left behind means a submitted transaction with an unrecorded outcome: inspect, never blind retry.';

comment on column public.payment_requests.status is
  'pending -> processing (row won by one payer) -> paid or cancelled.';
