-- Invite refs are Flizy usernames. /i/ludarep and /claim/{token}/ludarep.
-- Opaque Crockford slugs are rewritten to the account's current username.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Drop the 10-char Crockford checks so we can rewrite values.
-- ---------------------------------------------------------------------------

alter table public.invite_codes
  drop constraint if exists invite_codes_code_format;

alter table public.claims
  drop constraint if exists claims_invite_code_format;

-- ---------------------------------------------------------------------------
-- 2. Rewrite claim snapshots while the old slug still maps to an account.
-- ---------------------------------------------------------------------------

update public.claims c
set invite_code = a.username
from public.invite_codes ic
join public.accounts a on a.id = ic.account_id
where c.invite_code is not null
  and c.invite_code = ic.code
  and a.username is not null
  and btrim(a.username) <> '';

-- ---------------------------------------------------------------------------
-- 3. invite_codes.code becomes the live username.
-- ---------------------------------------------------------------------------

update public.invite_codes ic
set code = a.username
from public.accounts a
where a.id = ic.account_id
  and a.username is not null
  and btrim(a.username) <> '';

delete from public.invite_codes ic
where not exists (
  select 1
  from public.accounts a
  where a.id = ic.account_id
    and a.username is not null
    and btrim(a.username) <> ''
);

insert into public.invite_codes (account_id, code)
select a.id, a.username
from public.accounts a
where a.username is not null
  and btrim(a.username) <> ''
on conflict (account_id) do update
  set code = excluded.code;

-- ---------------------------------------------------------------------------
-- 4. New format: same shape as accounts.username (3-24, letter then a-z0-9).
-- ---------------------------------------------------------------------------

alter table public.invite_codes
  add constraint invite_codes_code_format
  check (code ~ '^[a-z][a-z0-9]{2,23}$');

alter table public.claims
  add constraint claims_invite_code_format
  check (invite_code is null or invite_code ~ '^[a-z][a-z0-9]{2,23}$');

comment on column public.invite_codes.code is
  'Public invite ref. Equals the owner Flizy username. /i/{username}.';
comment on column public.claims.invite_code is
  'Optional snapshot of the sender username at hold time. Attribution only.';

-- ---------------------------------------------------------------------------
-- 5. Post-condition
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'invite_codes_code_format'
  ) then
    raise exception 'invite_codes_code_format was not recreated';
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'claims_invite_code_format'
  ) then
    raise exception 'claims_invite_code_format was not recreated';
  end if;
  if exists (
    select 1 from public.invite_codes
    where code !~ '^[a-z][a-z0-9]{2,23}$'
  ) then
    raise exception 'invite_codes still contains a non-username ref';
  end if;
end
$$;
