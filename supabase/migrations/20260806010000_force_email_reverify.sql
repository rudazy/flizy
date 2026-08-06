-- Force every account to prove email ownership again.
-- Clears grandfathered email_verified_at and wipes web sessions so users
-- must log in and complete the verify gate before using the dashboard.
--
-- Apply only after outbound mail (Gmail SMTP) is confirmed working.
-- Idempotent: safe to run twice.

-- 1. Require code for everyone (including accounts verified only by grandfather).
update public.accounts
set email_verified_at = null
where email is not null;

-- 2. Log everyone out of the website.
delete from public.web_sessions;

comment on column public.accounts.email_verified_at is
  'When the registration email was proven via a one-time code. Null blocks the dashboard until verified.';
