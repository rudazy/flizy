-- One collection per fee.
--
-- The fee of a payment approved with the passkey is collected after the
-- payment lands, through the daily permission (lib/engine/sendFee.js
-- collectApprovedFee). Both the approval worker and the reconciler can reach
-- that step for the same payment, so the fee is claimed first:
--
--   fee_ledger.collecting_at   set, from null, by the one run that sends the
--                              fee (lib/feeQuote.js claimFee). A claimed fee is
--                              never sent again, including one sent with no
--                              answer, which stays pending for the operator.
--
-- Until this is applied, a claim fails and the fee is left pending, not sent.
-- Idempotent. A partial apply fails the post-condition.

alter table public.fee_ledger add column if not exists collecting_at timestamptz;

comment on column public.fee_ledger.collecting_at is
  'When collection of a pending fee was claimed. Only the claiming run sends it.';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'fee_ledger' and column_name = 'collecting_at'
  ) then
    raise exception 'fee_ledger.collecting_at is missing';
  end if;
end
$$;
