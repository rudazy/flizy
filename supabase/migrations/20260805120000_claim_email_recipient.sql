-- Email claim addressing mode + optional additional emails per account.
--
-- Why a third mode (to_email) instead of platform external_id:
--   normalizeExternalId strips "@" for chat/platform ids. An email cannot live
--   there without corrupting the address. Phone has to_wa_hint; email gets
--   to_email the same way.
--
-- Exactly one mode per claim (updated check):
--   phone     to_wa_hint set; to_channel, to_external_id, to_email null
--   platform  to_channel + to_external_id set; to_wa_hint, to_email null
--   email     to_email set; to_wa_hint, to_channel, to_external_id null
--
-- Registration email (accounts.email) is always a claim key (account ownership).
-- Additional addresses live in account_emails and are claimable only when
-- verified_at is set (proof of control). Unverified rows are storage only.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. claims.to_email
-- ---------------------------------------------------------------------------

alter table public.claims
  add column if not exists to_email text;

comment on column public.claims.to_email is
  'Normalized lowercased email the claim is reserved for. Pays out only after an account owns that email (registration or verified secondary).';

create index if not exists claims_to_email_status_idx
  on public.claims (to_email, status)
  where to_email is not null;

-- ---------------------------------------------------------------------------
-- 2. Widen recipient mode check for email
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'claims_recipient_mode_check'
  ) then
    alter table public.claims drop constraint claims_recipient_mode_check;
  end if;
end
$$;

alter table public.claims
  add constraint claims_recipient_mode_check
  check (
    (
      to_wa_hint is not null
      and btrim(to_wa_hint) <> ''
      and to_channel is null
      and to_external_id is null
      and to_email is null
    )
    or (
      to_channel is not null
      and to_external_id is not null
      and btrim(to_external_id) <> ''
      and to_wa_hint is null
      and to_email is null
    )
    or (
      to_email is not null
      and btrim(to_email) <> ''
      and to_wa_hint is null
      and to_channel is null
      and to_external_id is null
    )
  );

-- ---------------------------------------------------------------------------
-- 3. account_emails (additional, claimable only when verified)
-- ---------------------------------------------------------------------------

create table if not exists public.account_emails (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  email text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint account_emails_email_format check (
    position('@' in email) > 1
    and length(email) <= 254
  )
);

-- One global owner per email address (same idea as accounts.email unique).
create unique index if not exists account_emails_email_unique
  on public.account_emails (lower(email));

create index if not exists account_emails_account_idx
  on public.account_emails (account_id, created_at desc);

comment on table public.account_emails is
  'Secondary emails for an account. Only rows with verified_at set can match email claims. Registration email stays on accounts.email.';
