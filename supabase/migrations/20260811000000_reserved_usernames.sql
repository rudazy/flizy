-- Reserved usernames: block impersonation-adjacent Flizy @names.
-- Matched on reservedKey (lowercase, strip non a-z0-9, collapse repeated chars).
-- Seeds store the key form, never the raw display spelling.
-- App returns a friendly 400/409; this trigger stops SQL / service_role bypass.
-- No admin grant path in v1. Do not auto-rename existing holders.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table if not exists public.reserved_usernames (
  normalized_name text primary key,
  category text not null,
  reason text,
  created_at timestamptz not null default now(),
  constraint reserved_usernames_normalized_name_nonempty
    check (length(btrim(normalized_name)) > 0),
  constraint reserved_usernames_category_nonempty
    check (length(btrim(category)) > 0)
);

comment on table public.reserved_usernames is
  'Flizy @username blocklist. normalized_name is reservedKey(name): lower, strip non a-z0-9, collapse repeated chars. Never returned to clients.';
comment on column public.reserved_usernames.normalized_name is
  'reservedKey form. Lookup and seeds must use the same function (JS reservedKey / SQL username_reserved_key).';
comment on column public.reserved_usernames.category is
  'Internal: brand | role | money | infra.';
comment on column public.reserved_usernames.reason is
  'Internal only. Never expose to clients.';

alter table public.reserved_usernames enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Shared normalize (must match lib/username.js reservedKey)
-- ---------------------------------------------------------------------------

create or replace function public.username_reserved_key(raw text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when raw is null then ''
    else regexp_replace(
      regexp_replace(
        lower(btrim(regexp_replace(raw, '^@+', ''))),
        '[^a-z0-9]',
        '',
        'g'
      ),
      '(.)\1+',
      '\1',
      'g'
    )
  end;
$$;

comment on function public.username_reserved_key(text) is
  'Must match JS reservedKey: trim, strip leading @, lower, strip non a-z0-9, collapse repeated chars.';

-- ---------------------------------------------------------------------------
-- 3. Trigger: refuse insert/update of a reserved username on accounts
-- ---------------------------------------------------------------------------

create or replace function public.accounts_enforce_username_not_reserved()
returns trigger
language plpgsql
as $$
declare
  key text;
begin
  if new.username is null or btrim(new.username) = '' then
    return new;
  end if;

  key := public.username_reserved_key(new.username);
  if key = '' then
    return new;
  end if;

  if exists (
    select 1
    from public.reserved_usernames r
    where r.normalized_name = key
  ) then
    raise exception 'username is reserved'
      using errcode = 'FZ002',
            detail = 'username matches a reserved key';
  end if;

  return new;
end
$$;

drop trigger if exists accounts_username_not_reserved on public.accounts;
create trigger accounts_username_not_reserved
  before insert or update of username
  on public.accounts
  for each row
  execute function public.accounts_enforce_username_not_reserved();

-- ---------------------------------------------------------------------------
-- 4. Seed (keys are reservedKey of the product names; do not edit to raw form)
--    Source spellings: brand / role / money / security-sensitive infra only.
--    Route words (settings, dashboard, login, ...) omitted: usernames are not
--    URL path segments in the current app.
-- ---------------------------------------------------------------------------

insert into public.reserved_usernames (normalized_name, category, reason) values
  -- brand
  ('flizy', 'brand', 'product name'),
  ('flizyap', 'brand', 'flizyapp'),
  ('flizyoficial', 'brand', 'flizyofficial'),
  ('flizysuport', 'brand', 'flizysupport'),
  ('flizyteam', 'brand', 'flizyteam'),
  ('flizybot', 'brand', 'flizybot'),
  ('flizyhelp', 'brand', 'flizyhelp'),
  ('flizyadmin', 'brand', 'flizyadmin'),
  ('flizywalet', 'brand', 'flizywallet'),
  ('flizypay', 'brand', 'flizypay'),
  ('flizyhq', 'brand', 'flizyhq'),
  -- role / staff
  ('admin', 'role', 'staff'),
  ('administrator', 'role', 'staff'),
  ('suport', 'role', 'support'),
  ('help', 'role', 'staff'),
  ('oficial', 'role', 'official'),
  ('team', 'role', 'staff'),
  ('staf', 'role', 'staff'),
  ('mod', 'role', 'moderator'),
  ('moderator', 'role', 'staff'),
  ('security', 'role', 'staff'),
  ('verify', 'role', 'verification phishing'),
  ('verified', 'role', 'verification phishing'),
  ('trust', 'role', 'trust phishing'),
  ('trusted', 'role', 'trust phishing'),
  -- money
  ('pay', 'money', 'money word'),
  ('payment', 'money', 'money word'),
  ('payments', 'money', 'money word'),
  ('walet', 'money', 'wallet'),
  ('walets', 'money', 'wallets'),
  ('biling', 'money', 'billing'),
  ('refund', 'money', 'money word'),
  ('balance', 'money', 'money word'),
  ('deposit', 'money', 'money word'),
  ('withdraw', 'money', 'money word'),
  ('escrow', 'money', 'money word'),
  ('claim', 'money', 'money word'),
  ('claims', 'money', 'money word'),
  ('send', 'money', 'money word'),
  -- security-sensitive infra
  ('rot', 'infra', 'root'),
  ('system', 'infra', 'system'),
  ('bot', 'infra', 'bot'),
  ('bots', 'infra', 'bots'),
  ('api', 'infra', 'api'),
  ('mail', 'infra', 'mail'),
  ('email', 'infra', 'email'),
  ('noreply', 'infra', 'noreply'),
  ('postmaster', 'infra', 'postmaster'),
  ('abuse', 'infra', 'abuse'),
  ('nul', 'infra', 'null'),
  ('undefined', 'infra', 'undefined')
on conflict (normalized_name) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Post-conditions
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.reserved_usernames') is null then
    raise exception 'reserved_usernames was not created';
  end if;
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'username_reserved_key'
  ) then
    raise exception 'username_reserved_key was not created';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'accounts_username_not_reserved'
      and not tgisinternal
  ) then
    raise exception 'accounts_username_not_reserved trigger was not created';
  end if;
end
$$;
