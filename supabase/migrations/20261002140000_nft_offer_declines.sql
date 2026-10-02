-- Offers an NFT owner has declined.
--
-- An offer cannot be refused on chain: the ETH belongs to whoever made it until
-- it is accepted, and only they can cancel it. Declining is the owner saying no
-- here: the offer leaves their lists on the site and in chat, and the maker is
-- told in chat so they can cancel it and take their ETH back.
--
-- Keyed by marketplace as well as offer id, because offer ids start again at 1
-- on every marketplace deployment. Written by POST /api/nfts/offers/decline, read
-- by the site's offer lists and by "flizy accept offer" (lib/router.js).
--
-- Re-running is safe.

create table if not exists public.nft_offer_declines (
  account_id uuid not null references public.accounts (id) on delete cascade,
  marketplace text not null,
  offer_id text not null,
  created_at timestamptz not null default now(),
  primary key (account_id, marketplace, offer_id)
);

alter table public.nft_offer_declines drop constraint if exists nft_offer_declines_marketplace_check;
alter table public.nft_offer_declines
  add constraint nft_offer_declines_marketplace_check check (marketplace ~ '^0x[0-9a-fA-F]{40}$');

alter table public.nft_offer_declines drop constraint if exists nft_offer_declines_offer_id_check;
alter table public.nft_offer_declines
  add constraint nft_offer_declines_offer_id_check check (offer_id ~ '^[1-9][0-9]{0,77}$');

alter table public.nft_offer_declines enable row level security;

revoke all on table public.nft_offer_declines from anon, authenticated;

grant all on table public.nft_offer_declines to service_role;

do $$
begin
  if to_regclass('public.nft_offer_declines') is null then
    raise exception 'nft_offer_declines is missing';
  end if;

  if (
    select count(*) from pg_constraint
    where conrelid = 'public.nft_offer_declines'::regclass
      and conname in ('nft_offer_declines_marketplace_check', 'nft_offer_declines_offer_id_check')
  ) <> 2 then
    raise exception 'nft_offer_declines constraints are incomplete';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'nft_offer_declines' and c.relrowsecurity
  ) then
    raise exception 'nft_offer_declines row level security is off';
  end if;
end;
$$;
