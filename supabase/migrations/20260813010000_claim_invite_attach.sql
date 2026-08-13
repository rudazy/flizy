-- Optional invite on claims: a sender toggle, and a snapshot of their code
-- on the hold. Claim money stays claim-first. The invite is attribution only.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Sender preference. Default off: a claim is a claim unless they opt in.
-- ---------------------------------------------------------------------------

alter table public.accounts
  add column if not exists attach_invite_on_claims boolean not null default false;

comment on column public.accounts.attach_invite_on_claims is
  'When true, new claims this account sends snapshot their invite code. Existing holds are unchanged.';

-- ---------------------------------------------------------------------------
-- 2. Snapshot on the hold. Null = this claim does not carry an invite.
-- ---------------------------------------------------------------------------

alter table public.claims
  add column if not exists invite_code text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'claims_invite_code_format'
  ) then
    alter table public.claims
      add constraint claims_invite_code_format
      check (invite_code is null or invite_code ~ '^[0-9a-hjkmnp-tv-z]{10}$');
  end if;
end
$$;

comment on column public.claims.invite_code is
  'Optional snapshot of the sender invite code at hold time. Attribution only. Not a money key.';

-- ---------------------------------------------------------------------------
-- 3. Attribution source may now be a claim link.
-- ---------------------------------------------------------------------------

alter table public.invite_attributions
  drop constraint if exists invite_attributions_source_check;

alter table public.invite_attributions
  add constraint invite_attributions_source_check
  check (source in ('invite_link', 'claim_link'));

-- ---------------------------------------------------------------------------
-- 4. Post-condition
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'accounts'
      and column_name = 'attach_invite_on_claims'
  ) then
    raise exception 'accounts.attach_invite_on_claims was not created';
  end if;
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'claims'
      and column_name = 'invite_code'
  ) then
    raise exception 'claims.invite_code was not created';
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'invite_attributions_source_check'
  ) then
    raise exception 'invite_attributions_source_check was not recreated';
  end if;
end
$$;
