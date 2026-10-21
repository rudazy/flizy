-- Connected-wallet transactions on Scan, recorded once each.
--
-- A wallet outside Flizy can swap, trade NFTs and deposit into a Flizy wallet
-- from the site. It signs in the browser, so the page hands the transaction
-- hash to POST /api/scan/record and the server reads what happened from the
-- chain (web/lib/walletScanRecord.ts). The row goes into transfers with no
-- account and phone = 'wallet', the channel key Scan shows as "Outside wallet".
--
-- The page may hand the same hash over more than once. This index makes the
-- second insert fail, so each transaction is one row.
--
-- external_pay_attempts, the per-caller counter (web/lib/callerLimit.ts),
-- also caps these calls, under keys "record:" followed by the hashed client
-- address. Only its comment changes here.
--
-- Idempotent: safe to run twice.

create unique index if not exists transfers_wallet_tx_once
  on public.transfers (tx_hash)
  where phone = 'wallet';

comment on index public.transfers_wallet_tx_once is
  'One row per connected-wallet transaction recorded for Scan.';

comment on table public.external_pay_attempts is
  'One row per capped call from a caller without a Flizy account: outside-wallet pay confirms, and wallet-mode reads, trade plans, notices and Scan records. Keyed on a hashed client address. Service role only.';

-- ---------------------------------------------------------------------------
-- Post-condition: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where c.relname = 'transfers_wallet_tx_once'
      and i.indrelid = 'public.transfers'::regclass
      and i.indisunique
  ) then
    raise exception 'transfers_wallet_tx_once is missing or not unique';
  end if;
  if coalesce(obj_description('public.external_pay_attempts'::regclass, 'pg_class'), '') not like '%Scan records%' then
    raise exception 'external_pay_attempts comment was not updated';
  end if;
end
$$;
