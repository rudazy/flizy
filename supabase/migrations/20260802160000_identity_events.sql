-- Append-only audit of every identity bind outcome.
--
-- Records outcomes, not just actions: a refused link is the row you want when
-- somebody asks why their payout went somewhere else, or when reviewing whether
-- an identity was ever briefly bound to another account. Once money routes by
-- username this is the only durable answer to "who held this handle, when".
--
-- Append-only is enforced twice, and the trigger is the real guard. REVOKE
-- stops the roles the app connects as, but the table owner and any superuser
-- bypass table privileges entirely, and migrations run as exactly that. The
-- trigger raises for everyone.
--
-- Rows are written inside the bind core and the unlink path so no caller can
-- forget one.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table if not exists public.identity_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts (id) on delete set null,
  channel text not null,
  external_id text not null,
  display_handle text,
  event_type text not null,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'identity_events_event_type_check'
  ) then
    alter table public.identity_events
      add constraint identity_events_event_type_check
      check (event_type in (
        'LINKED',
        'UNLINKED',
        'HANDLE_REFRESHED',
        'LINK_REJECTED_ALREADY_TAKEN',
        'LINK_REJECTED_ALREADY_LINKED'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'identity_events_channel_check'
  ) then
    alter table public.identity_events
      add constraint identity_events_channel_check
      check (channel in ('whatsapp', 'telegram', 'x', 'github', 'discord'));
  end if;
end
$$;

-- account_id is nullable and ON DELETE SET NULL on purpose: deleting an account
-- must not erase the record that a bind happened, which is the point of an audit
-- table. channel and external_id survive so the trail stays readable.

create index if not exists identity_events_account_idx
  on public.identity_events (account_id, created_at desc);

create index if not exists identity_events_identity_idx
  on public.identity_events (channel, external_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Append-only, enforced
-- ---------------------------------------------------------------------------

create or replace function public.identity_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'identity_events is append-only: % is not permitted', tg_op
    using errcode = 'FZ002';
end
$$;

drop trigger if exists identity_events_no_update on public.identity_events;
create trigger identity_events_no_update
  before update or delete on public.identity_events
  for each row
  execute function public.identity_events_append_only();

alter table public.identity_events enable row level security;

revoke update, delete on public.identity_events from anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke update, delete on public.identity_events from service_role';
  end if;
end
$$;

comment on table public.identity_events is
  'Append-only audit of identity bind outcomes. UPDATE and DELETE are refused by trigger identity_events_no_update, which binds the table owner too, unlike REVOKE.';

-- ---------------------------------------------------------------------------
-- 3. Post-condition
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.identity_events') is null then
    raise exception 'identity_events was not created';
  end if;
  if not exists (
    select 1 from pg_trigger where tgname = 'identity_events_no_update'
  ) then
    raise exception 'the append-only trigger was not created';
  end if;
end
$$;
