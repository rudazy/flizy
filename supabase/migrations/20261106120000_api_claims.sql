-- Flizy Pay API, phase 2b: payouts to a phone, an email or a platform id
-- become escrow claims, with an expiry, a cancel and a refund.
--
-- claims gains expires_at and api_transaction_id. Both stay null for a claim
-- made in chat, which keeps working exactly as before (no expiry). An API claim
-- carries both: the VPS worker (lib/api/payoutWorker.js) refunds it to the
-- platform's wallet once it is past expires_at and still unclaimed.
--
-- api_transactions gains the claim link (handed to the platform, which knows
-- its own user and delivers it), the expiry chosen and when it falls, the
-- refund's transaction hash (stored before its broadcast) and the time a
-- cancel was asked for.
--
-- Service role only. Idempotent. A partial apply fails the post-condition.

alter table public.claims add column if not exists expires_at timestamptz;
alter table public.claims add column if not exists api_transaction_id uuid references public.api_transactions (id) on delete set null;
create index if not exists claims_api_transaction_idx on public.claims (api_transaction_id) where api_transaction_id is not null;

alter table public.api_transactions add column if not exists claim_url text;
alter table public.api_transactions add column if not exists claim_expiry_days integer;
alter table public.api_transactions add column if not exists claim_expires_at timestamptz;
alter table public.api_transactions add column if not exists refund_tx_hash text;
alter table public.api_transactions add column if not exists cancel_requested_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'api_transactions_claim_expiry_check'
  ) then
    alter table public.api_transactions
      add constraint api_transactions_claim_expiry_check
      check (claim_expiry_days is null or claim_expiry_days between 1 and 365);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'api_transactions_refund_hash_check'
  ) then
    alter table public.api_transactions
      add constraint api_transactions_refund_hash_check
      check (refund_tx_hash is null or refund_tx_hash ~ '^0x[0-9a-f]{64}$');
  end if;
end;
$$;

create index if not exists api_transactions_claims_idx
  on public.api_transactions (state, updated_at)
  where kind = 'payout' and state in ('claim_pending', 'expired', 'refund_pending');

do $$
declare
  c text;
begin
  foreach c in array array['expires_at', 'api_transaction_id'] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'claims' and column_name = c
    ) then
      raise exception 'claims.% is missing', c;
    end if;
  end loop;
  foreach c in array array['claim_url', 'claim_expiry_days', 'claim_expires_at', 'refund_tx_hash', 'cancel_requested_at'] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'api_transactions' and column_name = c
    ) then
      raise exception 'api_transactions.% is missing', c;
    end if;
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'api_transactions_claim_expiry_check') then
    raise exception 'constraint api_transactions_claim_expiry_check is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'api_transactions_refund_hash_check') then
    raise exception 'constraint api_transactions_refund_hash_check is missing';
  end if;
end;
$$;
