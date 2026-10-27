-- One WhatsApp and one Telegram per account, and a short note of where a
-- site session was opened.
--
-- Chat used to allow a second row so a changed WhatsApp LID could be linked
-- beside the old one. A second chat on the same app is now refused. The owner
-- unlinks the one that is there, then links the new one.
--
-- client_label and client_place are display text only. They are not an address
-- and not a user agent. Older sessions leave them null.
--
-- Idempotent. A partial apply fails the post-condition.

-- ---------------------------------------------------------------------------
-- 1. Session place
-- ---------------------------------------------------------------------------

alter table public.web_sessions
  add column if not exists client_label text,
  add column if not exists client_place text;

comment on column public.web_sessions.client_label is
  'Short device name from the sign-in, such as Chrome on Windows. Not a raw user agent.';

comment on column public.web_sessions.client_place is
  'City and country when the host provides them. Not an IP address.';

-- ---------------------------------------------------------------------------
-- 2. Pre-flight: one chat row per account per app
-- ---------------------------------------------------------------------------

do $$
declare
  offenders text;
begin
  select string_agg(format('account=%s channel=%s n=%s', account_id, channel, n), '; ')
  into offenders
  from (
    select account_id, channel, count(*) as n
    from public.channel_identities
    where channel in ('whatsapp', 'telegram')
    group by account_id, channel
    having count(*) > 1
  ) bad;

  if offenders is not null then
    raise exception 'cannot add one-chat-per-account index, existing violations: %', offenders;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The index
-- ---------------------------------------------------------------------------

create unique index if not exists channel_identities_account_chat_idx
  on public.channel_identities (account_id, channel)
  where channel in ('whatsapp', 'telegram');

comment on index public.channel_identities_account_chat_idx is
  'One WhatsApp and one Telegram per account. A second link is refused until the existing one is unlinked. Name is matched by lib/channelBind.js.';

-- ---------------------------------------------------------------------------
-- 4. Post-condition
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'web_sessions'
      and column_name = 'client_label'
  ) then
    raise exception 'web_sessions.client_label was not added';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'web_sessions'
      and column_name = 'client_place'
  ) then
    raise exception 'web_sessions.client_place was not added';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'channel_identities_account_chat_idx'
  ) then
    raise exception 'channel_identities_account_chat_idx was not created';
  end if;
end
$$;
