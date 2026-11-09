-- Flizy Pay API, phase 3a: checkouts paid from any wallet.
--
-- A platform creates a payment (api_transactions, kind 'payment') and sends its
-- customer to flizy.app/checkout/<id>. The customer pays through
-- FlizyPaymentReceiver, which forwards the whole amount straight to the
-- platform's wallet in the same transaction and logs the checkout's invoice id;
-- Flizy never holds the money. Each on-chain payment for a checkout is recorded
-- once, here, by api_record_payment, whether the checkout page reported it or
-- the VPS watcher found it in the receiver's logs (lib/api/paymentWatcher.js).
--
-- Payments toward one checkout add up. It settles when the total reaches the
-- amount (accepted -> submitted -> confirmed, each with its webhook event),
-- flagged overpaid when the total is more. Less stays open, reported. One that
-- lands after the checkout expired, or after it settled, is recorded and
-- reported, never lost; the checkout's state does not change.
--
-- api_platform_origins: the only origins a checkout may send the payer back to.
-- api_payment_cursor: the last block of receiver logs the watcher has read.
--
-- Service role only. Idempotent. A partial apply fails the post-condition.

alter table public.api_transactions add column if not exists invoice_id text;
alter table public.api_transactions add column if not exists expires_at timestamptz;
alter table public.api_transactions add column if not exists return_url text;
alter table public.api_transactions add column if not exists received_units numeric(78, 0) not null default 0;
alter table public.api_transactions add column if not exists overpaid boolean not null default false;
alter table public.api_transactions add column if not exists settled_at timestamptz;
create unique index if not exists api_transactions_invoice_idx on public.api_transactions (invoice_id) where invoice_id is not null;
create index if not exists api_transactions_open_payments_idx
  on public.api_transactions (expires_at) where kind = 'payment' and state = 'accepted';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_transactions_invoice_check') then
    alter table public.api_transactions
      add constraint api_transactions_invoice_check check (invoice_id is null or invoice_id ~ '^0x[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'api_transactions_return_url_check') then
    alter table public.api_transactions
      add constraint api_transactions_return_url_check check (return_url is null or (return_url ~ '^https://[^\s]+$' and char_length(return_url) <= 2000));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'api_transactions_payment_shape_check') then
    alter table public.api_transactions
      add constraint api_transactions_payment_shape_check check (kind <> 'payment' or (invoice_id is not null and expires_at is not null));
  end if;
end;
$$;

create table if not exists public.api_payment_receipts (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.api_transactions (id) on delete cascade,
  tx_hash text not null,
  log_index integer not null,
  payer text not null,
  units numeric(78, 0) not null,
  late boolean not null default false,
  created_at timestamptz not null default now(),
  constraint api_payment_receipts_once unique (tx_hash, log_index),
  constraint api_payment_receipts_hash_check check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  constraint api_payment_receipts_payer_check check (payer ~ '^0x[0-9a-f]{40}$'),
  constraint api_payment_receipts_units_check check (units > 0)
);
create index if not exists api_payment_receipts_tx_idx on public.api_payment_receipts (transaction_id);

create table if not exists public.api_platform_origins (
  platform_id uuid not null references public.api_platforms (id) on delete cascade,
  origin text not null,
  created_at timestamptz not null default now(),
  primary key (platform_id, origin),
  constraint api_platform_origins_check check (origin ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and char_length(origin) <= 260)
);

create table if not exists public.api_payment_cursor (
  id boolean primary key default true,
  last_block bigint,
  updated_at timestamptz not null default now(),
  constraint api_payment_cursor_single_row check (id)
);
insert into public.api_payment_cursor (id) values (true) on conflict (id) do nothing;

-- One on-chain payment for one checkout, recorded once, in one transaction.
-- The caller has already checked the log: from FlizyPaymentReceiver, this
-- checkout's invoice id, to the platform's wallet, in the checkout's asset.
-- Returns what happened: duplicate, partial, confirmed, late or extra.
create or replace function public.api_record_payment(
  p_transaction_id uuid,
  p_tx_hash text,
  p_log_index integer,
  p_payer text,
  p_units numeric,
  p_payee_account_id uuid,
  p_payee_address text,
  p_asset text,
  p_token_address text,
  p_amount_text text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  tx public.api_transactions;
  receipt_id uuid;
  total numeric;
  ev_type text;
  outcome text;
begin
  select * into tx from public.api_transactions where id = p_transaction_id and kind = 'payment' for update;
  if tx.id is null then
    raise exception 'api payment not found';
  end if;
  if p_units is null or p_units <= 0 then
    raise exception 'api payment units must be positive';
  end if;

  insert into public.api_payment_receipts (transaction_id, tx_hash, log_index, payer, units, late)
  values (p_transaction_id, lower(p_tx_hash), p_log_index, lower(p_payer), p_units, tx.state = 'expired')
  on conflict (tx_hash, log_index) do nothing
  returning id into receipt_id;
  if receipt_id is null then
    return 'duplicate';
  end if;

  -- The platform's History, like any payment from outside Flizy.
  insert into public.external_payments (tx_hash, log_index, invoice_id, payer_address, payee_account_id, payee_address, asset, token_address, amount_units, amount, note)
  values (lower(p_tx_hash), p_log_index, tx.invoice_id, lower(p_payer), p_payee_account_id, lower(p_payee_address), p_asset, p_token_address, p_units, p_amount_text, tx.reference)
  on conflict (tx_hash, log_index) do nothing;

  total := tx.received_units + p_units;
  update public.api_transactions set received_units = total, updated_at = now() where id = tx.id;

  if tx.state = 'accepted' and total >= tx.amount::numeric then
    update public.api_transactions set overpaid = total > tx.amount::numeric, settled_at = now(), tx_hash = lower(p_tx_hash) where id = tx.id;
    perform public.api_transition(tx.id, 'submitted', jsonb_build_object('tx_hash', lower(p_tx_hash)));
    perform public.api_transition(tx.id, 'confirmed', jsonb_build_object('tx_hash', lower(p_tx_hash), 'received_units', total::text, 'overpaid', total > tx.amount::numeric));
    return 'confirmed';
  end if;

  if tx.state = 'accepted' then
    ev_type := 'payment.partially_paid';
    outcome := 'partial';
  elsif tx.state = 'expired' then
    ev_type := 'payment.received_after_expiry';
    outcome := 'late';
  else
    update public.api_transactions set overpaid = true where id = tx.id;
    ev_type := 'payment.received_after_settlement';
    outcome := 'extra';
  end if;
  insert into public.api_webhook_events (platform_id, transaction_id, type, payload)
  values (
    tx.platform_id,
    tx.id,
    ev_type,
    jsonb_build_object(
      'object', 'payment',
      'id', tx.id,
      'state', tx.state,
      'detail', jsonb_build_object('tx_hash', lower(p_tx_hash), 'units', p_units::text, 'received_units', total::text)
    )
  );
  return outcome;
end;
$$;

alter table public.api_payment_receipts enable row level security;
alter table public.api_platform_origins enable row level security;
alter table public.api_payment_cursor enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['api_payment_receipts', 'api_platform_origins', 'api_payment_cursor'] loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end;
$$;
revoke all on function public.api_record_payment(uuid, text, integer, text, numeric, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.api_record_payment(uuid, text, integer, text, numeric, uuid, text, text, text, text) to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['api_payment_receipts', 'api_platform_origins', 'api_payment_cursor'] loop
    if to_regclass('public.' || t) is null then
      raise exception 'public.% is missing', t;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'row level security is off on public.%', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select') then
      raise exception 'public.% is readable by anon or authenticated', t;
    end if;
  end loop;
  if to_regprocedure('public.api_record_payment(uuid, text, integer, text, numeric, uuid, text, text, text, text)') is null then
    raise exception 'function api_record_payment is missing';
  end if;
  if has_function_privilege('anon', 'public.api_record_payment(uuid, text, integer, text, numeric, uuid, text, text, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.api_record_payment(uuid, text, integer, text, numeric, uuid, text, text, text, text)', 'execute') then
    raise exception 'api_record_payment is executable by anon or authenticated';
  end if;
  if (select count(*) from public.api_payment_cursor) <> 1 then
    raise exception 'api_payment_cursor must have exactly one row';
  end if;
  if to_regclass('public.api_transactions_invoice_idx') is null then
    raise exception 'index api_transactions_invoice_idx is missing';
  end if;
end;
$$;
