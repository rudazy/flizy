-- Token page: an admin-edited profile, a per-account watchlist, and community
-- theses with likes and comments.
--
-- token_key names a listed token in lower case ('flz'). The application only
-- accepts listed keys, so these tables never hold a row for an arbitrary
-- contract.
--
-- Everything is service-role only. Authors are accounts; the application
-- returns their @username and never the account id.
--
-- Additive only. Re-running is safe.

-- ---------------------------------------------------------------------------
-- 1. Profile
-- ---------------------------------------------------------------------------

create table if not exists public.token_profiles (
  token_key text primary key,
  logo text,
  description text not null default '',
  links jsonb not null default '[]'::jsonb,
  creator_username text,
  updated_at timestamptz,
  updated_by uuid references public.accounts (id) on delete set null,
  constraint token_profiles_key_format check (token_key ~ '^[a-z0-9]{2,12}$'),
  constraint token_profiles_logo_format check (
    logo is null
    or (
      char_length(logo) <= 200000
      and logo ~ '^data:image/(webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$'
    )
  ),
  constraint token_profiles_description_len check (char_length(description) <= 500),
  constraint token_profiles_links_is_array check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 8)
);

comment on table public.token_profiles is
  'What the token page shows above the price: logo, description, links and creator. Admin-edited.';

insert into public.token_profiles (token_key) values ('flz') on conflict (token_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Watchlist
-- ---------------------------------------------------------------------------

create table if not exists public.token_watchlist (
  account_id uuid not null references public.accounts (id) on delete cascade,
  token_key text not null,
  created_at timestamptz not null default now(),
  primary key (account_id, token_key)
);

comment on table public.token_watchlist is 'Tokens an account starred.';

-- ---------------------------------------------------------------------------
-- 3. Theses, likes, comments
-- ---------------------------------------------------------------------------

create table if not exists public.token_theses (
  id uuid primary key default gen_random_uuid(),
  token_key text not null,
  account_id uuid not null references public.accounts (id) on delete cascade,
  sentiment text not null,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint token_theses_sentiment_check check (sentiment in ('bullish', 'neutral', 'bearish')),
  constraint token_theses_body_len check (char_length(btrim(body)) between 1 and 500)
);

create index if not exists token_theses_token_idx on public.token_theses (token_key, created_at desc);
create index if not exists token_theses_account_idx on public.token_theses (account_id, created_at desc);

create table if not exists public.token_thesis_likes (
  thesis_id uuid not null references public.token_theses (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (thesis_id, account_id)
);

create table if not exists public.token_thesis_comments (
  id uuid primary key default gen_random_uuid(),
  thesis_id uuid not null references public.token_theses (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint token_thesis_comments_body_len check (char_length(btrim(body)) between 1 and 300)
);

create index if not exists token_thesis_comments_thesis_idx on public.token_thesis_comments (thesis_id, created_at);
create index if not exists token_thesis_comments_account_idx on public.token_thesis_comments (account_id, created_at desc);

comment on table public.token_theses is 'A take on a token, marked bullish, neutral or bearish. deleted_at hides it.';
comment on table public.token_thesis_comments is 'Replies to a thesis. deleted_at hides it.';

-- Likes and live comments per thesis, counted where the rows are.
create or replace function public.token_thesis_counts(p_ids uuid[])
returns table (thesis_id uuid, likes bigint, comments bigint)
language sql
stable
set search_path = public, pg_temp
as $$
  select t.id,
    (select count(*) from public.token_thesis_likes l where l.thesis_id = t.id)::bigint,
    (select count(*) from public.token_thesis_comments c where c.thesis_id = t.id and c.deleted_at is null)::bigint
  from public.token_theses t
  where t.id = any(p_ids)
$$;

-- ---------------------------------------------------------------------------
-- Access: service role only.
-- ---------------------------------------------------------------------------

alter table public.token_profiles enable row level security;
alter table public.token_watchlist enable row level security;
alter table public.token_theses enable row level security;
alter table public.token_thesis_likes enable row level security;
alter table public.token_thesis_comments enable row level security;

revoke all on table public.token_profiles from anon, authenticated;
revoke all on table public.token_watchlist from anon, authenticated;
revoke all on table public.token_theses from anon, authenticated;
revoke all on table public.token_thesis_likes from anon, authenticated;
revoke all on table public.token_thesis_comments from anon, authenticated;

grant all on table public.token_profiles to service_role;
grant all on table public.token_watchlist to service_role;
grant all on table public.token_theses to service_role;
grant all on table public.token_thesis_likes to service_role;
grant all on table public.token_thesis_comments to service_role;

revoke all on function public.token_thesis_counts(uuid[]) from public;
revoke all on function public.token_thesis_counts(uuid[]) from anon, authenticated;
grant execute on function public.token_thesis_counts(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- Post-conditions: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.token_profiles') is null then
    raise exception 'public.token_profiles is missing';
  end if;
  if to_regclass('public.token_watchlist') is null then
    raise exception 'public.token_watchlist is missing';
  end if;
  if to_regclass('public.token_theses') is null then
    raise exception 'public.token_theses is missing';
  end if;
  if to_regclass('public.token_thesis_likes') is null then
    raise exception 'public.token_thesis_likes is missing';
  end if;
  if to_regclass('public.token_thesis_comments') is null then
    raise exception 'public.token_thesis_comments is missing';
  end if;
  if to_regprocedure('public.token_thesis_counts(uuid[])') is null then
    raise exception 'function token_thesis_counts is missing';
  end if;
  if not exists (select 1 from public.token_profiles where token_key = 'flz') then
    raise exception 'token_profiles has no flz row';
  end if;
end $$;
