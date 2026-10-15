-- Secondary emails: an address belongs to whoever verifies it, not to whoever
-- typed it first.
--
-- account_emails_email_unique made lower(email) unique across every row,
-- verified or not. Adding someone else's address without ever verifying it
-- therefore blocked that address for everyone, including its real owner, and
-- email claims sent to it could never be collected.
--
-- After this migration:
--   - verified rows are unique per address (one owner per inbox, the rule the
--     old index meant to enforce);
--   - an account lists an address at most once;
--   - unverified rows no longer block anyone. Only verified rows ever match an
--     email claim (lib/accountEmails.js, web/lib/claimPayout.ts), so an
--     unverified row grants nothing.
--
-- The new indexes are built before the old one is dropped, so the table is
-- never without a uniqueness rule. The old index guaranteed both new
-- conditions, so neither can fail to build on existing data.
--
-- Idempotent: safe to run twice.

create unique index if not exists account_emails_verified_email_unique
  on public.account_emails (lower(email))
  where verified_at is not null;

create unique index if not exists account_emails_account_email_unique
  on public.account_emails (account_id, lower(email));

drop index if exists public.account_emails_email_unique;

do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'account_emails_verified_email_unique'
  ) then
    raise exception 'account_emails_verified_email_unique missing after migration';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'account_emails_account_email_unique'
  ) then
    raise exception 'account_emails_account_email_unique missing after migration';
  end if;
  if exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'account_emails_email_unique'
  ) then
    raise exception 'account_emails_email_unique still present after migration';
  end if;
end
$$;
