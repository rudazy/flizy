-- Claims can be addressed to a platform identity, not only to a phone.
--
-- Until now the only recipient column was to_wa_hint, a phone. A claim held for
-- a GitHub or Discord or X user has no phone to put there, so the recipient is
-- generalized into a second addressing mode. Existing phone claims are
-- untouched and keep using to_wa_hint.
--
-- Exactly one mode per claim:
--   phone     to_wa_hint set,  to_channel and to_external_id null
--   platform  to_channel and to_external_id set,  to_wa_hint null
--
-- to_external_id is the platform's IMMUTABLE numeric user id, never the handle.
-- Handles are renamed and reassigned; matching on one would hand a claim to
-- whoever picked up the name afterwards.
--
-- to_display_handle exists only so a confirm screen can say "@jack" instead of
-- "github user 583231". It is written once at send time, shown to humans, and
-- never read as a match key. Treat it as attacker-controlled text: it is put on
-- screen through displaySafeLabel, exactly like a payment request display name.
--
-- SAFETY: verified against the live table before writing this. claims held 1
-- row, 0 pending, and to_wa_hint was set and non-blank on every row, so the new
-- mode constraint validates without a backfill.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.claims
  add column if not exists to_channel text,
  add column if not exists to_external_id text,
  add column if not exists to_display_handle text;

-- ---------------------------------------------------------------------------
-- 2. The channel must be one the system knows
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'claims_to_channel_check'
  ) then
    alter table public.claims
      add constraint claims_to_channel_check
      check (
        to_channel is null
        or to_channel in ('whatsapp', 'telegram', 'x', 'github', 'discord')
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Exactly one addressing mode, never both, never neither
-- ---------------------------------------------------------------------------

-- Without this a claim could carry a phone AND a platform id, and the two match
-- paths would each find it: two different people could each be told the money
-- is theirs. Only one of them could actually be paid, because payout takes the
-- row first, but the other would have been shown a claim that was never theirs.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'claims_recipient_mode_check'
  ) then
    alter table public.claims
      add constraint claims_recipient_mode_check
      check (
        (
          to_wa_hint is not null
          and btrim(to_wa_hint) <> ''
          and to_channel is null
          and to_external_id is null
        )
        or (
          to_channel is not null
          and to_external_id is not null
          and btrim(to_external_id) <> ''
          and to_wa_hint is null
        )
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. The lookup path for the new mode
-- ---------------------------------------------------------------------------

-- Mirrors claims_to_wa_hint_status_idx. Partial, because only platform claims
-- carry these columns and the phone claims would otherwise bloat it.
create index if not exists claims_to_platform_status_idx
  on public.claims (to_channel, to_external_id, status)
  where to_channel is not null;

-- ---------------------------------------------------------------------------
-- 5. Post-condition
-- ---------------------------------------------------------------------------

do $$
declare
  missing text;
begin
  select string_agg(t.name, ', ')
  into missing
  from (values
    ('claims_to_channel_check'),
    ('claims_recipient_mode_check')
  ) as t(name)
  where not exists (select 1 from pg_constraint where conname = t.name);

  if missing is not null then
    raise exception 'claim recipient constraints missing: %', missing;
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'claims_to_platform_status_idx'
  ) then
    raise exception 'claims_to_platform_status_idx was not created';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Documentation
-- ---------------------------------------------------------------------------

comment on column public.claims.to_wa_hint is
  'Phone-addressed claims only. Normalized phone digits the claim is reserved for. Pays out only after that phone is proven on an account. Null for platform-addressed claims.';
comment on column public.claims.to_channel is
  'Platform-addressed claims only. Channel the recipient identity lives on (x, github, discord, and in principle the chat channels). Null for phone claims.';
comment on column public.claims.to_external_id is
  'Platform-addressed claims only. The platform''s immutable numeric user id, never the handle: handles are renamed and reassigned, ids are not.';
comment on column public.claims.to_display_handle is
  'Display only, never a match key. The handle as it read when the claim was created, so a confirm screen can name a person instead of an id. Attacker-controlled text: render through displaySafeLabel.';
