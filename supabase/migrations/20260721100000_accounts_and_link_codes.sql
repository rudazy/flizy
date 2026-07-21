-- Phase 1: permanent account identity, WhatsApp binding (LID-first), link codes.
-- Custody-agnostic: agent_wallet_address is a swappable pointer (stub until Phase 2).

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  -- Swappable agent wallet pointer (EOA stub now, smart wallet later)
  agent_wallet_address text,
  display_name text,
  is_admin boolean not null default false,
  -- Internal testnet credit until smart wallets (legacy bridge)
  balance_eth numeric(36, 18) not null default 0 check (balance_eth >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists accounts_agent_wallet_idx
  on public.accounts (agent_wallet_address)
  where agent_wallet_address is not null;

drop trigger if exists accounts_set_updated_at on public.accounts;
create trigger accounts_set_updated_at
  before update on public.accounts
  for each row
  execute function public.set_updated_at();

-- Observed WhatsApp sender id is source of truth (often a LID, not E.164).
create table if not exists public.whatsapp_identities (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  wa_sender_id text not null,
  wa_phone_e164 text,
  linked_at timestamptz not null default now(),
  constraint whatsapp_identities_sender_unique unique (wa_sender_id),
  constraint whatsapp_identities_sender_nonempty check (char_length(trim(wa_sender_id)) > 0)
);

create index if not exists whatsapp_identities_account_idx
  on public.whatsapp_identities (account_id);

-- One-time site -> WhatsApp bind codes (~10 min TTL enforced in app).
create table if not exists public.link_codes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  code text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint link_codes_code_unique unique (code),
  constraint link_codes_code_format check (code ~ '^[A-Z0-9]{6,12}$')
);

create index if not exists link_codes_account_idx on public.link_codes (account_id);
create index if not exists link_codes_expires_idx on public.link_codes (expires_at);

-- Optional link from legacy users row to new account (migration bridge).
alter table public.users
  add column if not exists account_id uuid references public.accounts (id) on delete set null;

create index if not exists users_account_id_idx on public.users (account_id);

-- transfers: optional account_id for new identity model
alter table public.transfers
  add column if not exists account_id uuid references public.accounts (id) on delete set null,
  add column if not exists chain_id integer,
  add column if not exists kind text default 'transfer';

alter table public.accounts enable row level security;
alter table public.whatsapp_identities enable row level security;
alter table public.link_codes enable row level security;

comment on table public.accounts is 'Permanent Flizy account. Wallet address is a swappable pointer.';
comment on table public.whatsapp_identities is 'WhatsApp sender ids (LID or phone) bound to accounts. Observed id wins.';
comment on table public.link_codes is 'Single-use site linking codes, short lived.';
