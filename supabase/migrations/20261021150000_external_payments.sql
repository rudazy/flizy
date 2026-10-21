-- Payments from wallets outside Flizy, made through FlizyPaymentReceiver.
--
-- A pay link can be paid from any browser wallet. The wallet calls
-- FlizyPaymentReceiver, which forwards the money to the payee in the same
-- transaction and emits PaymentReceived. The site then reads that event from
-- the transaction receipt and, only if the emitting contract, the payee, the
-- token and the amount all match, records it here and in transfers.
--
-- 1. external_payments: one row per PaymentReceived event, keyed on
--    (tx_hash, log_index), so confirming the same transaction twice records
--    one payment. The payee is a Flizy account; the payer is only an address.
-- 2. external_pay_attempts: one row per confirm call, keyed on a hash of the
--    caller's address, so the public confirm route can be capped per hour.
--    Each check costs an RPC read, and the caller needs no account.
--
-- 3. accounts.accept_outside_pay: off by default. Paying from an outside
--    wallet needs the payee's wallet address, and handing that out by
--    username or Flizy number links the name to the wallet's on-chain
--    activity, which Scan only does for accounts that ask
--    (scan_show_username). So only accounts that turn this on are payable
--    from outside wallets, and only theirs have the address handed out.
--
-- Service role only, like every table in public. Idempotent: safe to run twice.

alter table public.accounts
  add column if not exists accept_outside_pay boolean not null default false;

comment on column public.accounts.accept_outside_pay is
  'Whether pay links may be paid from wallets outside Flizy, which hands this account''s wallet address to anyone with the link. Off by default.';

create table if not exists public.external_payments (
  id uuid primary key default gen_random_uuid(),
  tx_hash text not null,
  log_index integer not null,
  invoice_id text not null,
  payer_address text not null,
  payee_account_id uuid not null references public.accounts (id) on delete cascade,
  payee_address text not null,
  asset text not null,
  token_address text,
  amount_units numeric(78, 0) not null,
  amount text not null,
  note text,
  transfer_id uuid references public.transfers (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint external_payments_tx_log_unique unique (tx_hash, log_index),
  constraint external_payments_tx_hash_check check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  constraint external_payments_invoice_check check (invoice_id ~ '^0x[0-9a-f]{64}$'),
  constraint external_payments_payer_check check (payer_address ~ '^0x[0-9a-f]{40}$'),
  constraint external_payments_payee_check check (payee_address ~ '^0x[0-9a-f]{40}$'),
  constraint external_payments_asset_check check (asset in ('ETH', 'FLZ', 'TUSD')),
  constraint external_payments_token_check check (token_address is null or token_address ~ '^0x[0-9a-f]{40}$'),
  constraint external_payments_amount_check check (amount_units > 0),
  constraint external_payments_note_len check (note is null or char_length(note) between 1 and 80)
);

create index if not exists external_payments_payee_idx
  on public.external_payments (payee_account_id, created_at desc);

alter table public.external_payments enable row level security;
revoke all on table public.external_payments from anon, authenticated;
grant all on table public.external_payments to service_role;

comment on table public.external_payments is
  'Payments from outside wallets through FlizyPaymentReceiver, one row per verified PaymentReceived event. Addresses and hashes lower case. Service role only.';

create table if not exists public.external_pay_attempts (
  id bigserial primary key,
  ip_key text not null,
  created_at timestamptz not null default now(),
  constraint external_pay_attempts_ip_key_check check (char_length(ip_key) between 16 and 128)
);

create index if not exists external_pay_attempts_ip_idx
  on public.external_pay_attempts (ip_key, created_at desc);

alter table public.external_pay_attempts enable row level security;
revoke all on table public.external_pay_attempts from anon, authenticated;
grant all on table public.external_pay_attempts to service_role;

comment on table public.external_pay_attempts is
  'One row per call to confirm an outside-wallet payment, keyed on a hashed client address, for the hourly cap. Service role only.';

-- ---------------------------------------------------------------------------
-- Post-conditions: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.external_payments') is null then
    raise exception 'public.external_payments is missing';
  end if;
  if to_regclass('public.external_pay_attempts') is null then
    raise exception 'public.external_pay_attempts is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'external_payments_tx_log_unique') then
    raise exception 'external_payments_tx_log_unique is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'accounts' and column_name = 'accept_outside_pay'
  ) then
    raise exception 'accounts.accept_outside_pay is missing';
  end if;
end
$$;
