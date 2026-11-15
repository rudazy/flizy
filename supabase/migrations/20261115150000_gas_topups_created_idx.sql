-- The daily gas top-up cap across every wallet (GAS_TOPUP_DAILY_CAP_USD,
-- lib/gasTopup.js, mirror web/lib/gasTopup.ts) totals the pending and sent
-- top-ups of the last 24 hours for all wallets. The existing index leads with
-- the wallet, so this one serves that read by time alone.
--
-- The code does not depend on it: without it the read is slower, not wrong.
-- Idempotent. A partial apply fails the post-condition.

create index if not exists gas_topups_created_idx
  on public.gas_topups (created_at desc)
  where status in ('pending', 'sent');

do $$
begin
  if not exists (select 1 from pg_indexes where indexname = 'gas_topups_created_idx') then
    raise exception 'gas_topups_created_idx is missing';
  end if;
end $$;
