-- Optional calling code for chat. Null means ask. Nothing is backfilled:
-- a national number must not start using Nigeria, or any other country,
-- just because this column exists.

alter table public.accounts
  add column if not exists default_calling_code text;

comment on column public.accounts.default_calling_code is
  'Optional calling code, digits only, no plus. Used when a send names a national phone number. Null means ask which country.';

alter table public.accounts
  drop constraint if exists accounts_default_calling_code_check;

alter table public.accounts
  add constraint accounts_default_calling_code_check
  check (
    default_calling_code is null
    or default_calling_code ~ '^[1-9][0-9]{0,3}$'
  );

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'accounts'
      and column_name = 'default_calling_code'
  ) then
    raise exception 'accounts.default_calling_code is missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.accounts'::regclass
      and conname = 'accounts_default_calling_code_check'
  ) then
    raise exception 'accounts_default_calling_code_check is missing';
  end if;
end $$;
