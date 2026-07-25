-- Channel-agnostic identity: (channel, external_id) -> account.
--
-- Generalizes whatsapp_identities WITHOUT moving rows: the table is renamed in
-- place, so every existing WhatsApp binding, index, grant and foreign key
-- survives untouched. Existing rows default to channel = 'whatsapp'.
--
-- Also enforces the account rule that matters most:
--   one phone maps to exactly one account, across every channel.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. whatsapp_identities -> channel_identities
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.channel_identities') is null then
    alter table public.whatsapp_identities rename to channel_identities;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'channel_identities'
      and column_name = 'wa_sender_id'
  ) then
    alter table public.channel_identities rename column wa_sender_id to external_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'channel_identities'
      and column_name = 'wa_phone_e164'
  ) then
    alter table public.channel_identities rename column wa_phone_e164 to phone_e164;
  end if;
end
$$;

alter table public.channel_identities
  add column if not exists channel text not null default 'whatsapp';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'channel_identities_channel_check'
  ) then
    alter table public.channel_identities
      add constraint channel_identities_channel_check
      check (channel in ('whatsapp', 'telegram'));
  end if;
end
$$;

-- Uniqueness is per channel: the same digits can legitimately be a WhatsApp LID
-- and an unrelated Telegram user id.
alter table public.channel_identities
  drop constraint if exists whatsapp_identities_sender_unique;

create unique index if not exists channel_identities_channel_external_idx
  on public.channel_identities (channel, external_id);

create index if not exists channel_identities_account_idx
  on public.channel_identities (account_id);

create index if not exists channel_identities_phone_idx
  on public.channel_identities (phone_e164)
  where phone_e164 is not null;

comment on table public.channel_identities is
  'Chat identities bound to accounts. One row per (channel, external_id). WhatsApp external_id is the observed sender id (often a LID); Telegram external_id is the numeric user id.';
comment on column public.channel_identities.phone_e164 is
  'Normalized phone digits (country code, no plus). Join key for claims/requests. One phone maps to exactly one account across every channel.';

-- ---------------------------------------------------------------------------
-- 2. One phone -> exactly one account, enforced in the database
-- ---------------------------------------------------------------------------

-- Surface pre-existing violations instead of hiding them. The trigger below only
-- guards new writes, so anything already conflicting stays visible here.
create or replace view public.channel_identity_phone_conflicts as
  select
    phone_e164,
    count(distinct account_id) as account_count,
    array_agg(distinct account_id) as account_ids
  from public.channel_identities
  where phone_e164 is not null
    and btrim(phone_e164) <> ''
  group by phone_e164
  having count(distinct account_id) > 1;

do $$
declare
  bad integer;
begin
  select count(*) into bad from public.channel_identity_phone_conflicts;
  if bad > 0 then
    raise warning 'channel_identities: % phone(s) are bound to more than one account. Inspect public.channel_identity_phone_conflicts and resolve before trusting claim routing.', bad;
  end if;
end
$$;

create or replace function public.channel_identities_enforce_one_phone()
returns trigger
language plpgsql
as $$
declare
  other_account uuid;
begin
  if new.phone_e164 is null or btrim(new.phone_e164) = '' then
    return new;
  end if;

  select ci.account_id into other_account
  from public.channel_identities ci
  where ci.phone_e164 = new.phone_e164
    and ci.account_id <> new.account_id
    and ci.id <> new.id
  limit 1;

  if other_account is not null then
    raise exception 'phone is already bound to a different Flizy account'
      using errcode = 'FZ001',
            detail = 'one phone maps to exactly one account across every channel';
  end if;

  return new;
end
$$;

drop trigger if exists channel_identities_one_phone on public.channel_identities;
create trigger channel_identities_one_phone
  before insert or update of phone_e164, account_id
  on public.channel_identities
  for each row
  execute function public.channel_identities_enforce_one_phone();

-- ---------------------------------------------------------------------------
-- 3. Backward-compatible view for readers not yet updated (deployed web app)
-- ---------------------------------------------------------------------------

drop view if exists public.whatsapp_identities;
create view public.whatsapp_identities as
  select
    id,
    account_id,
    external_id as wa_sender_id,
    phone_e164 as wa_phone_e164,
    linked_at
  from public.channel_identities
  where channel = 'whatsapp';

-- Views bypass the base table's RLS unless they run as the caller. Keep the
-- anon/authenticated keys locked out exactly as the base table is.
alter view public.whatsapp_identities set (security_invoker = true);
alter view public.channel_identity_phone_conflicts set (security_invoker = true);
revoke all on public.whatsapp_identities from anon, authenticated;
revoke all on public.channel_identity_phone_conflicts from anon, authenticated;

comment on view public.whatsapp_identities is
  'Compatibility view over channel_identities (channel = whatsapp). Read-only. New code uses channel_identities.';

-- ---------------------------------------------------------------------------
-- 4. Sessions are per (account, channel, identity)
--    Locking Telegram must not lock WhatsApp.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sessions'
      and column_name = 'wa_sender_id'
  ) then
    alter table public.sessions rename column wa_sender_id to external_id;
  end if;
end
$$;

alter table public.sessions
  add column if not exists channel text not null default 'whatsapp';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sessions_channel_check'
  ) then
    alter table public.sessions
      add constraint sessions_channel_check
      check (channel in ('whatsapp', 'telegram'));
  end if;
end
$$;

alter table public.sessions
  drop constraint if exists sessions_account_sender_unique;

create unique index if not exists sessions_account_channel_external_idx
  on public.sessions (account_id, channel, external_id);

comment on table public.sessions is
  'Unlock sessions per (account, channel, identity). Lock on one channel leaves other channels untouched.';

-- ---------------------------------------------------------------------------
-- 5. Link codes: record which channel burned the code (audit only)
-- ---------------------------------------------------------------------------

alter table public.link_codes
  add column if not exists used_by_channel text,
  add column if not exists used_by_external_id text;

comment on column public.link_codes.used_by_channel is
  'Channel that redeemed this single-use code (whatsapp | telegram).';
