-- Hold a re-signup's new password until its emailed code is entered.
--
-- Signing up again with an address whose account never verified its email
-- sends a fresh code. The password typed with that signup must not replace
-- the account's password until the code proves the inbox: otherwise anyone
-- could change the password of an unverified account, and its owner would be
-- locked out of signing in with the password they set.
--
-- The new password's hash waits on the code's row and is applied by
-- POST /api/auth/signup/verify only after that code is accepted. It is
-- cleared when the code is used and when a newer code replaces it, so it never
-- outlives its code. email_verifications is reachable by service_role only.
--
-- Idempotent: safe to run twice.

alter table public.email_verifications
  add column if not exists pending_password_hash text;

comment on column public.email_verifications.pending_password_hash is
  'Password hash from a re-signup of an unverified account. Applied only when this code is accepted at signup verify; cleared when the code is used or replaced.';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'email_verifications'
      and column_name = 'pending_password_hash'
  ) then
    raise exception 'email_verifications.pending_password_hash missing after migration';
  end if;
end
$$;
