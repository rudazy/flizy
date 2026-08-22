-- Close the advisor finding: account_emails and email_verifications were
-- created before enable-RLS-by-default, so PostgREST could serve them to
-- anon/authenticated. Match pay_codes: RLS on, no policies, revoke browser
-- roles. Service role bypasses RLS and is unchanged.
--
-- Idempotent: safe to run twice.

alter table public.account_emails enable row level security;
alter table public.email_verifications enable row level security;

revoke all on public.account_emails from anon, authenticated;
revoke all on public.email_verifications from anon, authenticated;

do $$
declare
  emails_rls boolean;
  verify_rls boolean;
  leftover int;
begin
  select c.relrowsecurity into emails_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'account_emails';
  if emails_rls is not true then
    raise exception 'account_emails still has row level security off';
  end if;

  select c.relrowsecurity into verify_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'email_verifications';
  if verify_rls is not true then
    raise exception 'email_verifications still has row level security off';
  end if;

  select count(*) into leftover
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('account_emails', 'email_verifications')
    and grantee in ('anon', 'authenticated');
  if leftover > 0 then
    raise exception 'anon/authenticated still hold grants on email tables';
  end if;
end
$$;
