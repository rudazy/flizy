-- Payment fees: a fee's state.
--
-- A fee row is written before its payment is sent, as pending, so a payment
-- whose outcome is not known yet still has its fee on record. It then moves
-- once, and only from pending:
--
--   charged   the fee landed (with its payment, or collected after a passkey
--             approved payment); tx_hash and the gas Flizy paid are set then.
--   waived    nothing was charged: the payment was not sent or reverted, or
--             the fee could not be collected after an approved payment.
--
-- The amounts on a row are never edited. A row written in one step (already
-- landed) is charged from the start, which is also the default for rows from
-- before this migration.
--
-- Idempotent. A partial apply fails the post-condition.

alter table public.fee_ledger add column if not exists state text not null default 'charged';
alter table public.fee_ledger add column if not exists settled_at timestamptz;
alter table public.fee_ledger add column if not exists waive_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fee_ledger_state_check') then
    alter table public.fee_ledger
      add constraint fee_ledger_state_check check (state in ('pending', 'charged', 'waived'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fee_ledger_waive_reason_check') then
    alter table public.fee_ledger
      add constraint fee_ledger_waive_reason_check check (waive_reason is null or char_length(waive_reason) <= 200);
  end if;
end $$;

create index if not exists fee_ledger_pending_idx on public.fee_ledger (source_kind, source_id) where state = 'pending';

comment on column public.fee_ledger.state is
  'pending until the payment settles; then charged or waived, once. Amounts are never edited.';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'fee_ledger' and column_name = 'state'
  ) then
    raise exception 'fee_ledger.state is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fee_ledger_state_check') then
    raise exception 'fee_ledger_state_check is missing';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'fee_ledger_pending_idx') then
    raise exception 'fee_ledger_pending_idx is missing';
  end if;
end $$;
