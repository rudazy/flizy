-- Secure this account: passkeys on the HybridDeleGator, and the bounded
-- delegations they sign for Flizy.
--
-- The ceremony is web/lib/custody/ceremony.ts; the caps and caveats are in
-- lib/custody/delegations.js.
--
--   custody_challenges   one-time WebAuthn challenges for making a passkey,
--                        burned on use (signing needs none: the passkey
--                        signs each delegation's own fresh digest)
--   custody_passkeys     a passkey's P-256 point and the addKey transaction
--   custody_delegations  one signed delegation per asset (ETH, FLZ, TUSD)
--
-- A delegation row holds what the passkey signed, byte for byte, so the engine
-- can redeem it later. Nothing here is secret: a public key, a signed
-- permission whose caps the chain enforces. Service role only, like every
-- table in public.
--
-- Idempotent: safe to run twice.

create table if not exists public.custody_challenges (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  purpose text not null,
  challenge text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint custody_challenges_purpose_check check (purpose in ('passkey_create')),
  constraint custody_challenges_challenge_check check (challenge ~ '^[A-Za-z0-9_-]{43}$')
);

create unique index if not exists custody_challenges_once
  on public.custody_challenges (challenge);

create index if not exists custody_challenges_account
  on public.custody_challenges (account_id, purpose, created_at desc);

create table if not exists public.custody_passkeys (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  key_id text not null,
  x text not null,
  y text not null,
  status text not null default 'pending',
  add_tx_hash text,
  created_at timestamptz not null default now(),
  added_at timestamptz,
  constraint custody_passkeys_key_id_check check (key_id ~ '^[A-Za-z0-9_-]+$' and char_length(key_id) between 16 and 1366),
  constraint custody_passkeys_point_check check (x ~ '^0x[0-9a-f]{64}$' and y ~ '^0x[0-9a-f]{64}$'),
  constraint custody_passkeys_status_check check (status in ('pending', 'added', 'failed')),
  constraint custody_passkeys_tx_check check (add_tx_hash is null or add_tx_hash ~ '^0x[0-9a-f]{64}$')
);

create unique index if not exists custody_passkeys_key_once
  on public.custody_passkeys (key_id);

create index if not exists custody_passkeys_account
  on public.custody_passkeys (account_id, created_at desc);

create table if not exists public.custody_delegations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  passkey_id uuid references public.custody_passkeys (id) on delete set null,
  symbol text not null,
  gator text not null,
  delegate text not null,
  salt text not null,
  signed_at timestamptz not null,
  expires_at timestamptz not null,
  digest text not null,
  caveats jsonb not null,
  signature text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  constraint custody_delegations_symbol_check check (symbol in ('ETH', 'FLZ', 'TUSD')),
  constraint custody_delegations_address_check check (gator ~ '^0x[0-9a-fA-F]{40}$' and delegate ~ '^0x[0-9a-fA-F]{40}$'),
  constraint custody_delegations_salt_check check (salt ~ '^[1-9][0-9]{0,77}$'),
  constraint custody_delegations_digest_check check (digest ~ '^0x[0-9a-f]{64}$'),
  constraint custody_delegations_status_check check (status in ('pending', 'active', 'replaced', 'revoked')),
  constraint custody_delegations_signed_check check (status = 'pending' or signature ~ '^0x[0-9a-f]+$')
);

create unique index if not exists custody_delegations_digest_once
  on public.custody_delegations (digest);

-- At most one live permission per asset per account.
create unique index if not exists custody_delegations_one_active
  on public.custody_delegations (account_id, symbol)
  where status = 'active';

create index if not exists custody_delegations_account
  on public.custody_delegations (account_id, created_at desc);

alter table public.custody_challenges enable row level security;
alter table public.custody_passkeys enable row level security;
alter table public.custody_delegations enable row level security;
revoke all on table public.custody_challenges from anon, authenticated;
revoke all on table public.custody_passkeys from anon, authenticated;
revoke all on table public.custody_delegations from anon, authenticated;
grant all on table public.custody_challenges to service_role;
grant all on table public.custody_passkeys to service_role;
grant all on table public.custody_delegations to service_role;

comment on table public.custody_challenges is
  'One-time WebAuthn challenges for making a passkey to secure an account. Burned on use. Service role only.';
comment on table public.custody_passkeys is
  'Passkeys added to an account''s HybridDeleGator as P-256 keys, with the addKey transaction. Public keys only. Service role only.';
comment on table public.custody_delegations is
  'Bounded delegations a passkey signed for Flizy, one live per asset per account, stored as signed so they can be redeemed. Service role only.';

-- ---------------------------------------------------------------------------
-- Post-condition: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['custody_challenges', 'custody_passkeys', 'custody_delegations'] loop
    if to_regclass('public.' || t) is null then
      raise exception 'public.% is missing', t;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'row level security is off on public.%', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select') then
      raise exception 'public.% is readable outside the service role', t;
    end if;
  end loop;
  if to_regclass('public.custody_delegations_one_active') is null then
    raise exception 'custody_delegations_one_active is missing';
  end if;
  if to_regclass('public.custody_passkeys_key_once') is null then
    raise exception 'custody_passkeys_key_once is missing';
  end if;
  if to_regclass('public.custody_challenges_once') is null then
    raise exception 'custody_challenges_once is missing';
  end if;
end
$$;
