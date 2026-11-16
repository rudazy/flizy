-- Business accounts.
--
-- An account opts in to being a business from Account > Business on the site,
-- after accepting the business terms (web/lib/businessTerms.ts). A business
-- pays the merchant fee on payments it receives, and its payers pay no fee.
--
--   accounts.is_business               on or off. Off by default.
--   accounts.business_terms_version    the terms version accepted when it was
--                                      last turned on.
--   accounts.business_since            when it was last turned on.
--
-- A business always has the terms it accepted (accounts_business_terms_check).
-- Turning it off keeps the record of the last acceptance; turning it on again
-- takes the terms again.
--
-- Idempotent. A partial apply fails the post-condition.

alter table public.accounts add column if not exists is_business boolean not null default false;
alter table public.accounts add column if not exists business_terms_version text;
alter table public.accounts add column if not exists business_since timestamptz;

alter table public.accounts drop constraint if exists accounts_business_terms_check;
alter table public.accounts
  add constraint accounts_business_terms_check
  check (
    (business_terms_version is null or char_length(business_terms_version) between 1 and 40)
    and (not is_business or (business_terms_version is not null and business_since is not null))
  );

comment on column public.accounts.is_business is
  'A business account: pays the merchant fee on payments it receives. Opt-in, with the business terms.';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'accounts' and column_name = 'is_business'
  ) then
    raise exception 'accounts.is_business is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounts_business_terms_check') then
    raise exception 'accounts_business_terms_check is missing';
  end if;
end
$$;
