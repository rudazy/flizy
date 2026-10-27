-- A payment that reached a Flizy account.
--
-- One row is one arrival. The signed-in account reads the stored sentence in
-- the app. The site emails that sentence, plus one fixed line, to the
-- registration address. The pair (account_id, dedupe_key) is unique, so the
-- same arrival is not stored twice. A different asset in the same transaction
-- is a different arrival. Only the service role touches this table.
-- Re-running is safe.

create table if not exists public.account_notices (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  kind text not null default 'payment',
  body text not null,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  mailed_at timestamptz,
  constraint account_notices_kind_check check (kind = 'payment'),
  constraint account_notices_body_len check (char_length(body) between 1 and 600),
  constraint account_notices_dedupe_len check (char_length(dedupe_key) between 8 and 96),
  constraint account_notices_account_dedupe unique (account_id, dedupe_key)
);

comment on table public.account_notices is
  'A payment that reached this account. Shown in the app and emailed once.';

create index if not exists account_notices_account_idx
  on public.account_notices (account_id, created_at desc);

alter table public.account_notices enable row level security;

revoke all on table public.account_notices from anon, authenticated;

grant all on table public.account_notices to service_role;

do $$
begin
  if to_regclass('public.account_notices') is null then
    raise exception 'account_notices is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.account_notices'::regclass
      and conname = 'account_notices_kind_check'
  ) then
    raise exception 'account_notices_kind_check is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.account_notices'::regclass
      and conname = 'account_notices_body_len'
  ) then
    raise exception 'account_notices_body_len is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.account_notices'::regclass
      and conname = 'account_notices_dedupe_len'
  ) then
    raise exception 'account_notices_dedupe_len is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.account_notices'::regclass
      and conname = 'account_notices_account_dedupe'
  ) then
    raise exception 'account_notices_account_dedupe is missing';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'account_notices' and c.relrowsecurity
  ) then
    raise exception 'account_notices row level security is off';
  end if;
end;
$$;
