-- Flizy Pay API, phase 2c: webhook delivery and large-payout notices.
--
-- Every state change already writes its event in the same transaction
-- (api_transition, 20261104120000_api_foundation.sql). This adds what delivers
-- them: a delivery per event and endpoint, so each endpoint has its own
-- status, attempts and next try, and the VPS worker (lib/api/webhookWorker.js)
-- fans events out to the endpoints that want them and delivers each one. A
-- delivery that fails never touches the payout it describes.
--
-- api_webhook_endpoints gains a label, the last characters of its secret (to
-- tell secrets apart; the secret itself is stored only encrypted) and an
-- updated time. api_webhook_events gains the 'dispatched' status: fanned out.
-- api_platform_limits gains notice_at: a payout of at least this much, in the
-- asset's base units, is emailed to the platform's owner when it is accepted.
--
-- Service role only. Idempotent. A partial apply fails the post-condition.

alter table public.api_webhook_endpoints add column if not exists label text not null default '';
alter table public.api_webhook_endpoints add column if not exists secret_hint text;
alter table public.api_webhook_endpoints add column if not exists updated_at timestamptz not null default now();
create index if not exists api_webhook_endpoints_platform_idx on public.api_webhook_endpoints (platform_id);
alter table public.api_platform_limits add column if not exists notice_at text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_webhook_endpoints_label_check') then
    alter table public.api_webhook_endpoints
      add constraint api_webhook_endpoints_label_check check (char_length(label) <= 60);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'api_webhook_endpoints_secret_check') then
    alter table public.api_webhook_endpoints
      add constraint api_webhook_endpoints_secret_check check (secret_ciphertext ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'api_platform_limits_notice_check') then
    alter table public.api_platform_limits
      add constraint api_platform_limits_notice_check check (notice_at is null or notice_at ~ '^[1-9][0-9]{0,77}$');
  end if;
end;
$$;

-- 'dispatched': fanned out to its endpoints' deliveries. A changed rule gets a
-- new name, so the old one is dropped and this one added under its own.
alter table public.api_webhook_events drop constraint if exists api_webhook_events_status_check;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_webhook_events_dispatch_status_check') then
    alter table public.api_webhook_events
      add constraint api_webhook_events_dispatch_status_check check (status in ('pending', 'dispatched', 'delivered', 'failed'));
  end if;
end;
$$;

create table if not exists public.api_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.api_webhook_events (id) on delete cascade,
  endpoint_id uuid not null references public.api_webhook_endpoints (id) on delete cascade,
  platform_id uuid not null references public.api_platforms (id) on delete cascade,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  constraint api_webhook_deliveries_once unique (event_id, endpoint_id),
  constraint api_webhook_deliveries_status_check check (status in ('pending', 'delivered', 'failed')),
  constraint api_webhook_deliveries_error_check check (last_error is null or char_length(last_error) <= 300)
);
create index if not exists api_webhook_deliveries_due_idx
  on public.api_webhook_deliveries (next_attempt_at) where status = 'pending';
create index if not exists api_webhook_deliveries_platform_idx
  on public.api_webhook_deliveries (platform_id, created_at desc);

alter table public.api_webhook_attempts add column if not exists delivery_id uuid references public.api_webhook_deliveries (id) on delete cascade;

alter table public.api_webhook_deliveries enable row level security;
revoke all on table public.api_webhook_deliveries from anon, authenticated;
grant all on table public.api_webhook_deliveries to service_role;

do $$
begin
  if to_regclass('public.api_webhook_deliveries') is null then
    raise exception 'public.api_webhook_deliveries is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.api_webhook_deliveries'::regclass) then
    raise exception 'row level security is off on public.api_webhook_deliveries';
  end if;
  if has_table_privilege('anon', 'public.api_webhook_deliveries', 'select')
     or has_table_privilege('authenticated', 'public.api_webhook_deliveries', 'select') then
    raise exception 'public.api_webhook_deliveries is readable by anon or authenticated';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'api_platform_limits' and column_name = 'notice_at'
  ) then
    raise exception 'api_platform_limits.notice_at is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'api_webhook_endpoints' and column_name = 'secret_hint'
  ) then
    raise exception 'api_webhook_endpoints.secret_hint is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'api_webhook_endpoints_secret_check') then
    raise exception 'constraint api_webhook_endpoints_secret_check is missing';
  end if;
end;
$$;
