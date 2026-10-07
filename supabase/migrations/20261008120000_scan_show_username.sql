-- Whether Scan, the public ledger, may show this account's @username.
--
-- On by default. Off, Scan never names the account: payments it sends lose
-- the sender name, and payments to it show its short wallet address instead
-- of the username. A search for the username finds nothing. History, which
-- only the account itself sees, is unaffected.
--
-- Additive only. Re-running is safe.

alter table public.accounts
  add column if not exists scan_show_username boolean not null default true;

comment on column public.accounts.scan_show_username is
  'Scan may show the @username. False: Scan shows the short wallet address or nothing.';

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'accounts'
      and column_name = 'scan_show_username'
  ) then
    raise exception 'accounts.scan_show_username is missing';
  end if;
end $$;
