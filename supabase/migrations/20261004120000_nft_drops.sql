-- Flizy Mint: drops and their allowlists.
--
-- nft_drops is one row per collection that mints through Flizy.
--   mode 'flizy'    : FlizyDrop runs the mint on chain (phases, prices, limits,
--                     allowlist root). The chain is the source of truth for
--                     those rules; this row holds what the chain does not:
--                     who launched it on Flizy and how it is presented.
--   mode 'external' : the collection's own public mint function, called
--                     through Flizy (Contract-managed). Flizy controls none of
--                     its rules; external_mint_fn names the supported function.
-- creator_account_id is null for drops Flizy itself lists (Giwaforge).
--
-- nft_drop_allowlist is the creator's list for a 'flizy' drop: one row per
-- wallet with its allowance. A Flizy username is resolved to that account's
-- wallet when it is saved, so a later username change does not move the slot;
-- the username is kept only as a label. The Merkle root of these rows is what
-- the creator publishes to FlizyDrop.
--
-- Addresses are stored checksummed as the app writes them. URL checks keep the
-- length apart from the pattern: PostgreSQL regex repetition counts stop at 255.
-- Only the service role touches these tables, through /api/mints.
--
-- Re-running is safe.

create table if not exists public.nft_drops (
  id uuid primary key default gen_random_uuid(),
  collection text not null unique,
  mode text not null,
  creator_account_id uuid references public.accounts (id) on delete set null,
  name text not null,
  description text,
  image_url text,
  banner_url text,
  external_mint_fn text,
  allowlist_root text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.nft_drops drop constraint if exists nft_drops_collection_check;
alter table public.nft_drops
  add constraint nft_drops_collection_check check (collection ~ '^0x[0-9a-fA-F]{40}$');

alter table public.nft_drops drop constraint if exists nft_drops_mode_check;
alter table public.nft_drops
  add constraint nft_drops_mode_check check (mode in ('flizy', 'external'));

alter table public.nft_drops drop constraint if exists nft_drops_name_check;
alter table public.nft_drops
  add constraint nft_drops_name_check check (char_length(name) between 1 and 64);

alter table public.nft_drops drop constraint if exists nft_drops_description_check;
alter table public.nft_drops
  add constraint nft_drops_description_check check (description is null or char_length(description) <= 2000);

alter table public.nft_drops drop constraint if exists nft_drops_image_url_check;
alter table public.nft_drops
  add constraint nft_drops_image_url_check
  check (
    image_url is null
    or (char_length(image_url) <= 512 and image_url ~ '^(https|ipfs)://[^[:space:]"\\]+$')
  );

alter table public.nft_drops drop constraint if exists nft_drops_banner_url_check;
alter table public.nft_drops
  add constraint nft_drops_banner_url_check
  check (
    banner_url is null
    or (char_length(banner_url) <= 512 and banner_url ~ '^(https|ipfs)://[^[:space:]"\\]+$')
  );

-- An external drop names the one supported mint function it uses; a Flizy drop has none.
alter table public.nft_drops drop constraint if exists nft_drops_external_mint_fn_check;
alter table public.nft_drops
  add constraint nft_drops_external_mint_fn_check
  check (
    (mode = 'external' and external_mint_fn in ('claim', 'mint', 'mint_qty', 'public_mint_qty'))
    or (mode = 'flizy' and external_mint_fn is null)
  );

alter table public.nft_drops drop constraint if exists nft_drops_allowlist_root_check;
alter table public.nft_drops
  add constraint nft_drops_allowlist_root_check
  check (allowlist_root is null or allowlist_root ~ '^0x[0-9a-f]{64}$');

-- A creator's drops, newest first (My Mints).
create index if not exists nft_drops_creator_idx
  on public.nft_drops (creator_account_id, created_at desc);

create table if not exists public.nft_drop_allowlist (
  drop_id uuid not null references public.nft_drops (id) on delete cascade,
  address text not null,
  allowance integer not null,
  source text not null,
  account_id uuid references public.accounts (id) on delete set null,
  username text,
  created_at timestamptz not null default now(),
  primary key (drop_id, address)
);

alter table public.nft_drop_allowlist drop constraint if exists nft_drop_allowlist_address_check;
alter table public.nft_drop_allowlist
  add constraint nft_drop_allowlist_address_check check (address ~ '^0x[0-9a-fA-F]{40}$');

alter table public.nft_drop_allowlist drop constraint if exists nft_drop_allowlist_allowance_check;
alter table public.nft_drop_allowlist
  add constraint nft_drop_allowlist_allowance_check check (allowance between 1 and 10000);

alter table public.nft_drop_allowlist drop constraint if exists nft_drop_allowlist_source_check;
alter table public.nft_drop_allowlist
  add constraint nft_drop_allowlist_source_check check (source in ('username', 'address', 'csv'));

alter table public.nft_drop_allowlist drop constraint if exists nft_drop_allowlist_username_check;
alter table public.nft_drop_allowlist
  add constraint nft_drop_allowlist_username_check
  check (username is null or char_length(username) between 1 and 32);

-- At most 10000 wallets per drop, counted under a per-drop lock so two parallel
-- inserts cannot both pass the count.
create or replace function public.nft_drop_allowlist_before_insert()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  held integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('nft_drop_allowlist:' || new.drop_id::text, 0));
  select count(*) into held from public.nft_drop_allowlist where drop_id = new.drop_id;
  if held >= 10000 then
    raise exception 'nft_drop_allowlist_cap' using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

drop trigger if exists nft_drop_allowlist_before_insert on public.nft_drop_allowlist;
create trigger nft_drop_allowlist_before_insert
  before insert on public.nft_drop_allowlist
  for each row execute function public.nft_drop_allowlist_before_insert();

alter table public.nft_drops enable row level security;
alter table public.nft_drop_allowlist enable row level security;

revoke all on table public.nft_drops from anon, authenticated;
revoke all on table public.nft_drop_allowlist from anon, authenticated;

grant all on table public.nft_drops to service_role;
grant all on table public.nft_drop_allowlist to service_role;

-- Giwaforge: Flizy's own test collection, minted through its public claim().
insert into public.nft_drops (collection, mode, creator_account_id, name, description, external_mint_fn)
values (
  '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A',
  'external',
  null,
  'Giwaforge',
  'Flizy''s test collection on GIWA Sepolia. One free NFT per wallet.',
  'claim'
)
on conflict (collection) do nothing;

do $$
begin
  if to_regclass('public.nft_drops') is null then
    raise exception 'nft_drops is missing';
  end if;

  if to_regclass('public.nft_drop_allowlist') is null then
    raise exception 'nft_drop_allowlist is missing';
  end if;

  if (
    select count(*) from pg_constraint
    where conrelid = 'public.nft_drops'::regclass
      and conname in (
        'nft_drops_collection_check', 'nft_drops_mode_check', 'nft_drops_name_check',
        'nft_drops_description_check', 'nft_drops_image_url_check', 'nft_drops_banner_url_check',
        'nft_drops_external_mint_fn_check', 'nft_drops_allowlist_root_check'
      )
  ) <> 8 then
    raise exception 'nft_drops constraints are incomplete';
  end if;

  if (
    select count(*) from pg_constraint
    where conrelid = 'public.nft_drop_allowlist'::regclass
      and conname in (
        'nft_drop_allowlist_address_check', 'nft_drop_allowlist_allowance_check',
        'nft_drop_allowlist_source_check', 'nft_drop_allowlist_username_check'
      )
  ) <> 4 then
    raise exception 'nft_drop_allowlist constraints are incomplete';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'nft_drop_allowlist_before_insert'
      and tgrelid = 'public.nft_drop_allowlist'::regclass
  ) then
    raise exception 'nft_drop_allowlist_before_insert trigger is missing';
  end if;

  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('nft_drops', 'nft_drop_allowlist')
      and not c.relrowsecurity
  ) then
    raise exception 'row level security is off on a drop table';
  end if;

  -- Evaluate the URL pattern once: a pattern Postgres cannot compile is only
  -- reported when a row is checked, and the seed row has no URL.
  if not ('https://flizy.app/a.png' ~ '^(https|ipfs)://[^[:space:]"\\]+$') then
    raise exception 'artwork URL pattern does not accept a plain https URL';
  end if;

  if not exists (
    select 1 from public.nft_drops
    where collection = '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A' and mode = 'external'
  ) then
    raise exception 'Giwaforge drop row is missing';
  end if;
end;
$$;
