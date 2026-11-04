-- Flizy Pay API, phase 1: platforms, keys, requests, idempotency, the
-- transaction state machine and the webhook outbox. No money moves through
-- anything here yet (docs: web/lib/apiKeys.ts, web/lib/apiStates.ts).
--
-- api_control        one row: the database half of the global payout switch.
-- api_platforms      the approval list: one approved account, one approved
--                    wallet, a Flizy-assigned display name, fee and claim
--                    expiry settings only Flizy sets.
-- api_keys           hashed keys with per-key permissions. 'payout' is never
--                    granted by the site; Flizy grants it.
-- api_key_events     key created, revoked, permissions changed. Written by a
--                    trigger so a change made by hand is recorded too, and
--                    emailed to the owner.
-- api_requests       one row per authenticated call: audit and rate limit.
-- api_idempotency    first answer to each Idempotency-Key, replayed on retry.
-- api_transactions   API payments and payouts and their state.
-- api_webhook_*      the outbox. api_transition() changes a state and writes
--                    its event in the same transaction.
--
-- Service role only. Idempotent. A partial apply fails the post-condition.

create table if not exists public.api_control (
  id boolean primary key default true,
  payouts_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint api_control_single_row check (id)
);
insert into public.api_control (id) values (true) on conflict (id) do nothing;

create table if not exists public.api_platforms (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null unique references public.accounts (id) on delete restrict,
  display_name text not null,
  wallet_address text not null,
  enabled boolean not null default false,
  fee_bps integer not null default 0,
  claim_expiry_default_days integer not null default 30,
  claim_expiry_max_days integer not null default 30,
  approved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_platforms_name_check check (char_length(btrim(display_name)) between 1 and 60),
  constraint api_platforms_wallet_check check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  constraint api_platforms_fee_check check (fee_bps between 0 and 1000),
  constraint api_platforms_expiry_check check (
    claim_expiry_default_days between 1 and 365
    and claim_expiry_max_days between 1 and 365
    and claim_expiry_default_days <= claim_expiry_max_days
  )
);

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references public.api_platforms (id) on delete cascade,
  mode text not null,
  prefix text not null,
  key_hash text not null unique,
  label text not null default '',
  scopes text[] not null default array['read']::text[],
  ip_allowlist text[],
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  rotated_from uuid references public.api_keys (id) on delete set null,
  constraint api_keys_mode_check check (mode in ('test', 'live')),
  constraint api_keys_hash_check check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint api_keys_label_check check (char_length(label) <= 60),
  constraint api_keys_scopes_check check (
    cardinality(scopes) between 1 and 3
    and scopes <@ array['read', 'collect', 'payout']::text[]
  ),
  constraint api_keys_ip_check check (ip_allowlist is null or cardinality(ip_allowlist) <= 20)
);
create index if not exists api_keys_platform_idx on public.api_keys (platform_id, created_at desc);
-- A key is rotated once: a second new key from the same old one is refused, so
-- two rotations at once cannot leave two live copies of its permissions.
create unique index if not exists api_keys_rotated_from_idx
  on public.api_keys (rotated_from) where rotated_from is not null;

create table if not exists public.api_key_events (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references public.api_keys (id) on delete cascade,
  platform_id uuid not null references public.api_platforms (id) on delete cascade,
  kind text not null,
  scopes text[],
  created_at timestamptz not null default now(),
  mailed_at timestamptz,
  constraint api_key_events_kind_check check (kind in ('created', 'revoked', 'scopes_changed'))
);
create index if not exists api_key_events_unmailed_idx on public.api_key_events (created_at) where mailed_at is null;

create table if not exists public.api_requests (
  id uuid primary key default gen_random_uuid(),
  request_id text not null,
  key_id uuid references public.api_keys (id) on delete set null,
  platform_id uuid references public.api_platforms (id) on delete set null,
  method text not null,
  path text not null,
  status integer not null,
  idempotency_key text,
  ip_key text,
  created_at timestamptz not null default now()
);
create index if not exists api_requests_key_time_idx on public.api_requests (key_id, created_at desc);

create table if not exists public.api_idempotency (
  key_id uuid not null references public.api_keys (id) on delete cascade,
  idempotency_key text not null,
  request_hash text not null,
  state text not null default 'in_progress',
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (key_id, idempotency_key),
  constraint api_idempotency_key_check check (idempotency_key ~ '^[\x21-\x7e]{1,255}$'),
  constraint api_idempotency_state_check check (state in ('in_progress', 'done'))
);

create table if not exists public.api_transactions (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references public.api_platforms (id) on delete restrict,
  key_id uuid references public.api_keys (id) on delete set null,
  kind text not null,
  state text not null default 'accepted',
  idempotency_key text,
  reference text,
  request jsonb not null default '{}'::jsonb,
  recipient_kind text,
  recipient_ref text,
  amount text,
  asset text,
  authorization_decision jsonb,
  tx_hash text,
  claim_id uuid,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_transactions_kind_check check (kind in ('payout', 'payment')),
  constraint api_transactions_state_check check (state in (
    'accepted', 'queued', 'submitted', 'confirmed', 'claim_pending',
    'failed', 'expired', 'refund_pending', 'refunded'
  )),
  constraint api_transactions_amount_check check (amount is null or amount ~ '^[0-9]+$'),
  constraint api_transactions_reference_check check (reference is null or char_length(reference) <= 120)
);
create index if not exists api_transactions_platform_idx on public.api_transactions (platform_id, created_at desc);
create unique index if not exists api_transactions_idem_idx
  on public.api_transactions (key_id, idempotency_key) where idempotency_key is not null;

create table if not exists public.api_webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references public.api_platforms (id) on delete cascade,
  url text not null,
  secret_ciphertext text,
  events text[] not null default array[]::text[],
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  constraint api_webhook_endpoints_url_check check (url ~ '^https://[^\s]+$' and char_length(url) <= 2000)
);

create table if not exists public.api_webhook_events (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references public.api_platforms (id) on delete cascade,
  transaction_id uuid references public.api_transactions (id) on delete set null,
  type text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  constraint api_webhook_events_status_check check (status in ('pending', 'delivered', 'failed'))
);
create index if not exists api_webhook_events_due_idx
  on public.api_webhook_events (next_attempt_at) where status = 'pending';

create table if not exists public.api_webhook_attempts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.api_webhook_events (id) on delete cascade,
  endpoint_id uuid references public.api_webhook_endpoints (id) on delete set null,
  attempted_at timestamptz not null default now(),
  http_status integer,
  error text,
  duration_ms integer
);
create index if not exists api_webhook_attempts_event_idx on public.api_webhook_attempts (event_id, attempted_at desc);

-- Key events by trigger, so a permission change made directly in the database
-- is recorded and mailed like one made on the site.
create or replace function public.api_key_event_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.api_key_events (key_id, platform_id, kind, scopes)
    values (new.id, new.platform_id, 'created', new.scopes);
  elsif new.revoked_at is not null and old.revoked_at is null then
    insert into public.api_key_events (key_id, platform_id, kind, scopes)
    values (new.id, new.platform_id, 'revoked', new.scopes);
  elsif new.scopes is distinct from old.scopes then
    insert into public.api_key_events (key_id, platform_id, kind, scopes)
    values (new.id, new.platform_id, 'scopes_changed', new.scopes);
  end if;
  return new;
end;
$$;

drop trigger if exists api_keys_events on public.api_keys;
create trigger api_keys_events
  after insert or update on public.api_keys
  for each row
  execute function public.api_key_event_trigger();

-- At most 10 live keys per platform (MAX_ACTIVE_KEYS in web/lib/apiPlatforms.ts).
-- The platform row is locked first, so two inserts at once are counted one
-- after the other. A rotation's new key does not count the key it replaces.
-- A second rotation of the same key is refused as unique_violation before the
-- count, so it gets the same answer whether or not the platform is at the cap.
create or replace function public.api_keys_cap_trigger()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform 1 from public.api_platforms where id = new.platform_id for update;
  if new.rotated_from is not null
     and exists (select 1 from public.api_keys where rotated_from = new.rotated_from) then
    raise exception 'api key already rotated' using errcode = 'unique_violation';
  end if;
  if (
    select count(*) from public.api_keys
    where platform_id = new.platform_id
      and revoked_at is null
      and id is distinct from new.rotated_from
  ) >= 10 then
    raise exception 'api key limit reached' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists api_keys_cap on public.api_keys;
create trigger api_keys_cap
  before insert on public.api_keys
  for each row
  execute function public.api_keys_cap_trigger();

-- The one way an API transaction changes state: checks the move is allowed,
-- applies it, and writes its webhook event in the same transaction. Mirrored by
-- web/lib/apiStates.ts; a test keeps the two lists equal.
create or replace function public.api_transition(
  p_transaction_id uuid,
  p_to_state text,
  p_detail jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_state text;
  tx_kind text;
  tx_platform uuid;
  allowed text[];
  event_id uuid;
begin
  select state, kind, platform_id into current_state, tx_kind, tx_platform
  from public.api_transactions
  where id = p_transaction_id
  for update;

  if current_state is null then
    raise exception 'api transaction not found';
  end if;

  allowed := case current_state
    when 'accepted' then array['queued', 'submitted', 'expired', 'failed']
    when 'queued' then array['submitted', 'failed']
    when 'submitted' then array['confirmed', 'claim_pending', 'failed']
    when 'claim_pending' then array['confirmed', 'expired', 'refund_pending']
    when 'expired' then array['refund_pending']
    when 'refund_pending' then array['refunded']
    else array[]::text[]
  end;

  if p_to_state is null or not (p_to_state = any (allowed)) then
    raise exception 'api transition % -> % is not allowed', current_state, p_to_state;
  end if;

  update public.api_transactions
  set state = p_to_state, updated_at = now()
  where id = p_transaction_id;

  insert into public.api_webhook_events (platform_id, transaction_id, type, payload)
  values (
    tx_platform,
    p_transaction_id,
    tx_kind || '.' || p_to_state,
    jsonb_build_object(
      'object', tx_kind,
      'id', p_transaction_id,
      'state', p_to_state,
      'previous_state', current_state,
      'detail', coalesce(p_detail, '{}'::jsonb)
    )
  )
  returning id into event_id;

  return event_id;
end;
$$;

-- Service role only, everywhere. Row level security on with no policies, so
-- only the service role (which bypasses it) can read or write.
alter table public.api_control enable row level security;
alter table public.api_platforms enable row level security;
alter table public.api_keys enable row level security;
alter table public.api_key_events enable row level security;
alter table public.api_requests enable row level security;
alter table public.api_idempotency enable row level security;
alter table public.api_transactions enable row level security;
alter table public.api_webhook_endpoints enable row level security;
alter table public.api_webhook_events enable row level security;
alter table public.api_webhook_attempts enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'api_control', 'api_platforms', 'api_keys', 'api_key_events', 'api_requests',
    'api_idempotency', 'api_transactions', 'api_webhook_endpoints',
    'api_webhook_events', 'api_webhook_attempts'
  ] loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end;
$$;

revoke all on function public.api_transition(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.api_transition(uuid, text, jsonb) to service_role;
revoke all on function public.api_key_event_trigger() from public, anon, authenticated;
revoke all on function public.api_keys_cap_trigger() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'api_control', 'api_platforms', 'api_keys', 'api_key_events', 'api_requests',
    'api_idempotency', 'api_transactions', 'api_webhook_endpoints',
    'api_webhook_events', 'api_webhook_attempts'
  ] loop
    if to_regclass('public.' || t) is null then
      raise exception 'public.% is missing', t;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'row level security is off on public.%', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'select') then
      raise exception 'public.% is readable by anon or authenticated', t;
    end if;
  end loop;
  if (select count(*) from public.api_control) <> 1 then
    raise exception 'api_control must have exactly one row';
  end if;
  if to_regprocedure('public.api_transition(uuid, text, jsonb)') is null then
    raise exception 'function api_transition is missing';
  end if;
  if has_function_privilege('anon', 'public.api_transition(uuid, text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.api_transition(uuid, text, jsonb)', 'execute') then
    raise exception 'api_transition is executable by anon or authenticated';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'api_keys_events' and tgrelid = 'public.api_keys'::regclass) then
    raise exception 'trigger api_keys_events is missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'api_keys_cap' and tgrelid = 'public.api_keys'::regclass) then
    raise exception 'trigger api_keys_cap is missing';
  end if;
  if to_regclass('public.api_keys_rotated_from_idx') is null then
    raise exception 'index api_keys_rotated_from_idx is missing';
  end if;
end;
$$;
