-- A display label for a bound identity.
--
-- Money is routed by the immutable platform user id in external_id. A handle is
-- not an identifier: GitHub, X and Discord all let people rename, and a freed
-- name can be taken by somebody else. So the handle is stored here purely so a
-- screen can say "@jack" instead of "github user 583231", and nothing may ever
-- match on it.
--
-- Same treatment as claims.to_display_handle, which this mirrors.
--
-- Idempotent: safe to run twice.

alter table public.channel_identities
  add column if not exists display_handle text;

comment on column public.channel_identities.display_handle is
  'Display only, never a match key. The handle as it read when the identity was last verified, so a screen can name a person instead of an id. Attacker-controlled text: render through displaySafeLabel. Routing uses external_id, which is the platform''s immutable numeric user id.';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'channel_identities'
      and column_name = 'display_handle'
  ) then
    raise exception 'channel_identities.display_handle was not added';
  end if;
end
$$;
