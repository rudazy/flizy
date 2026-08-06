-- Email ownership proof before email claims can pay out.
--
-- Risk without this: anyone can register (or add) an address they do not control
-- and collect holds addressed to that email. Codes prove inbox control.
--
-- accounts.email_verified_at: registration email is claimable only when set.
-- account_emails.verified_at already existed; codes now set it.
-- email_verifications: short-lived hashed codes (primary or secondary).
--
-- Existing accounts are grandfathered (verified_at = created_at) so live users
-- are not locked out; new signups and new secondaries must verify with a code.
--
-- Idempotent: safe to run twice.

alter table public.accounts
  add column if not exists email_verified_at timestamptz;

comment on column public.accounts.email_verified_at is
  'When the registration email was proven via a one-time code. Null = not claimable for email holds.';

-- Grandfather existing rows once (only where still null).
update public.accounts
set email_verified_at = coalesce(created_at, now())
where email is not null
  and email_verified_at is null;

create table if not exists public.email_verifications (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  email text not null,
  purpose text not null check (purpose in ('primary', 'secondary')),
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint email_verifications_email_format check (
    position('@' in email) > 1
    and length(email) <= 254
  )
);

create index if not exists email_verifications_account_idx
  on public.email_verifications (account_id, created_at desc);

create index if not exists email_verifications_email_open_idx
  on public.email_verifications (lower(email), purpose, created_at desc)
  where consumed_at is null;

comment on table public.email_verifications is
  'One-time email ownership codes. code_hash only; plaintext code is never stored.';
