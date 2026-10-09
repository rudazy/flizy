-- Scan names an account only when that account asks it to.
--
-- "Show username on Scan" was on by default, so every account was named on the
-- public ledger without ever choosing it. It is now off by default, and every
-- account is switched off once, because nobody chose the old default and there
-- is no record of who did. Anyone who wants their @username shown turns it on.
--
-- Re-running is safe: the switch-off runs only while the column default is
-- still true, and this migration sets it to false in the same transaction, so a
-- second run never undoes an account that opted in after the first.

do $$
declare
  current_default text;
begin
  select column_default into current_default
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'accounts'
    and column_name = 'scan_show_username';

  if current_default is null then
    raise exception 'accounts.scan_show_username is missing; run 20261008120000_scan_show_username.sql first';
  end if;

  if current_default = 'true' then
    alter table public.accounts alter column scan_show_username set default false;
    update public.accounts set scan_show_username = false where scan_show_username;
  end if;
end $$;

comment on column public.accounts.scan_show_username is
  'Scan may show the @username. Off by default. False: Scan shows the short wallet address or nothing.';

do $$
begin
  if (
    select column_default
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'accounts'
      and column_name = 'scan_show_username'
  ) is distinct from 'false' then
    raise exception 'accounts.scan_show_username default is not false';
  end if;
end $$;
