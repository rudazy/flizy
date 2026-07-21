-- Multi-user ledger + transfer history for Flizy

alter table public.users
  add column if not exists balance_eth numeric(36, 18) not null default 0
    check (balance_eth >= 0),
  add column if not exists is_admin boolean not null default false,
  add column if not exists display_name text;

comment on column public.users.balance_eth is 'Internal testnet credit (ETH units). Spent via send; credited by admin.';
comment on column public.users.is_admin is 'Admins can credit users and spend from the shared hot wallet pool.';

create table if not exists public.transfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users (id) on delete set null,
  phone text not null,
  to_address text not null,
  amount_eth numeric(36, 18) not null check (amount_eth > 0),
  tx_hash text,
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'confirmed', 'failed', 'cancelled')),
  error text,
  created_at timestamptz not null default now()
);

create index if not exists transfers_phone_created_idx
  on public.transfers (phone, created_at desc);

create index if not exists transfers_tx_hash_idx
  on public.transfers (tx_hash)
  where tx_hash is not null;

alter table public.transfers enable row level security;

comment on table public.transfers is 'Outbound send history from Flizy WhatsApp bot';
