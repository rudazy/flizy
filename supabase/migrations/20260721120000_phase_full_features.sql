-- Phase 1-6 data model: PIN, trusted addresses, sessions, claims

alter table public.accounts
  add column if not exists unlock_pin_hash text,
  add column if not exists email text,
  add column if not exists password_hash text;

create unique index if not exists accounts_email_unique
  on public.accounts (lower(email))
  where email is not null;

-- Trusted destinations: managed on site only (Phase 3)
create table if not exists public.trusted_addresses (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  address text not null,
  label text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trusted_addresses_addr_format check (address ~ '^0x[a-fA-F0-9]{40}$'),
  constraint trusted_addresses_unique unique (account_id, address)
);

create index if not exists trusted_addresses_account_idx
  on public.trusted_addresses (account_id);

drop trigger if exists trusted_addresses_set_updated_at on public.trusted_addresses;
create trigger trusted_addresses_set_updated_at
  before update on public.trusted_addresses
  for each row
  execute function public.set_updated_at();

-- Session unlock state (Phase 4). PIN verified server-side; no PIN stored in WA.
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  wa_sender_id text not null,
  unlocked_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint sessions_account_sender_unique unique (account_id, wa_sender_id)
);

create index if not exists sessions_expires_idx on public.sessions (expires_at);

-- Pending claims for send-to-non-user (Phase 6)
create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  from_account_id uuid references public.accounts (id) on delete set null,
  to_wa_hint text,
  to_account_id uuid references public.accounts (id) on delete set null,
  amount_eth numeric(36, 18) not null check (amount_eth > 0),
  token_address text,
  chain_id integer not null,
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'expired', 'cancelled')),
  claim_token text not null,
  tx_hash text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  constraint claims_token_unique unique (claim_token)
);

create index if not exists claims_status_idx on public.claims (status);

-- Mirror contacts into trusted when both exist: keep contacts as nicknames only.
-- Site trusted_addresses is the allowlist source of truth for sends.

alter table public.trusted_addresses enable row level security;
alter table public.sessions enable row level security;
alter table public.claims enable row level security;

comment on table public.trusted_addresses is 'Allowlist destinations. Site-only mutations. Enforced on sends.';
comment on table public.sessions is 'WhatsApp unlock sessions. 1h inactivity default.';
comment on table public.claims is 'Viral claim links for non-users.';
