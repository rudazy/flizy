-- NFT favorites: the heart on a marketplace card.
--
-- One row per account and token. Collection addresses are stored checksummed
-- as the app writes them; token ids are decimal text because ERC-721 ids run to
-- 78 digits, past what a numeric column survives as JSON.
--
-- Only the service role touches this table, through /api/nfts/favorites, which
-- takes the account from the session cookie.
--
-- Re-running is safe.

create table if not exists public.nft_favorites (
  account_id uuid not null references public.accounts (id) on delete cascade,
  collection text not null,
  token_id text not null,
  created_at timestamptz not null default now(),
  primary key (account_id, collection, token_id)
);

alter table public.nft_favorites drop constraint if exists nft_favorites_collection_check;
alter table public.nft_favorites
  add constraint nft_favorites_collection_check check (collection ~ '^0x[0-9a-fA-F]{40}$');

alter table public.nft_favorites drop constraint if exists nft_favorites_token_id_check;
alter table public.nft_favorites
  add constraint nft_favorites_token_id_check check (token_id ~ '^(0|[1-9][0-9]{0,77})$');

-- The account's hearts, newest first.
create index if not exists nft_favorites_account_idx
  on public.nft_favorites (account_id, created_at desc);

-- At most 500 favorites per account, counted under a per-account lock so two
-- parallel inserts cannot both pass the count.
create or replace function public.nft_favorites_before_insert()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  held integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('nft_favorites:' || new.account_id::text, 0));
  select count(*) into held from public.nft_favorites where account_id = new.account_id;
  if held >= 500 then
    raise exception 'nft_favorites_cap' using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

drop trigger if exists nft_favorites_before_insert on public.nft_favorites;
create trigger nft_favorites_before_insert
  before insert on public.nft_favorites
  for each row execute function public.nft_favorites_before_insert();

alter table public.nft_favorites enable row level security;

revoke all on table public.nft_favorites from anon, authenticated;

grant all on table public.nft_favorites to service_role;

do $$
begin
  if to_regclass('public.nft_favorites') is null then
    raise exception 'nft_favorites is missing';
  end if;

  if (
    select count(*) from pg_constraint
    where conrelid = 'public.nft_favorites'::regclass
      and conname in ('nft_favorites_collection_check', 'nft_favorites_token_id_check')
  ) <> 2 then
    raise exception 'nft_favorites constraints are incomplete';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'nft_favorites_before_insert'
      and tgrelid = 'public.nft_favorites'::regclass
  ) then
    raise exception 'nft_favorites_before_insert trigger is missing';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'nft_favorites' and c.relrowsecurity
  ) then
    raise exception 'nft_favorites row level security is off';
  end if;
end;
$$;
