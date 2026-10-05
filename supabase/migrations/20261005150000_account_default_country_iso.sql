-- The one country a person picked. Null means no country was chosen.
-- The dial stays in default_calling_code. This column is only which flag
-- and name to show, so United States and Canada can share +1 and still be
-- two choices. Nothing is backfilled.

alter table public.accounts
  add column if not exists default_country_iso text;

comment on column public.accounts.default_country_iso is
  'Optional ISO 3166-1 alpha-2 country. Null means no single country was picked. The send uses default_calling_code.';

alter table public.accounts
  drop constraint if exists accounts_default_country_iso_check;

alter table public.accounts
  add constraint accounts_default_country_iso_check
  check (
    default_country_iso is null
    or default_country_iso ~ '^[A-Z]{2}$'
  );

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'accounts'
      and column_name = 'default_country_iso'
  ) then
    raise exception 'accounts.default_country_iso is missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.accounts'::regclass
      and conname = 'accounts_default_country_iso_check'
  ) then
    raise exception 'accounts_default_country_iso_check is missing';
  end if;
end $$;
