-- What kind of device a site session is on, a second place when the network
-- and the device disagree, and when the session was last used.
--
-- client_place now comes from the device's time zone when the network's
-- geolocation names a different country (a phone in Lagos had been listed as
-- Nairobi). client_network_place keeps the network's answer beside it in that
-- case, because a time zone is set by whoever holds the device.
--
-- All four columns are display text or a timestamp. None is an address or a
-- user agent. Older sessions leave them null.
--
-- Idempotent. A partial apply fails the post-condition.

alter table public.web_sessions
  add column if not exists client_kind text,
  add column if not exists client_model text,
  add column if not exists client_network_place text,
  add column if not exists last_seen_at timestamptz;

alter table public.web_sessions
  drop constraint if exists web_sessions_client_kind_check;

alter table public.web_sessions
  add constraint web_sessions_client_kind_check
  check (client_kind is null or client_kind in ('phone', 'tablet', 'computer'));

comment on column public.web_sessions.client_kind is
  'phone, tablet or computer, from the sign-in request. Display only.';

comment on column public.web_sessions.client_model is
  'Handset model when the browser shares it, such as Samsung SM-A155F. Not a user agent.';

comment on column public.web_sessions.client_network_place is
  'City and country from the network, kept only when it disagrees with client_place. Not an IP address.';

comment on column public.web_sessions.last_seen_at is
  'Last authenticated request on this session, moved at most every 15 minutes.';

do $$
declare
  missing text;
begin
  select string_agg(c, ', ')
  into missing
  from unnest(array['client_kind', 'client_model', 'client_network_place', 'last_seen_at']) as c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'web_sessions'
      and column_name = c
  );

  if missing is not null then
    raise exception 'web_sessions columns were not added: %', missing;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'web_sessions_client_kind_check'
      and conrelid = 'public.web_sessions'::regclass
  ) then
    raise exception 'web_sessions_client_kind_check was not created';
  end if;
end
$$;
