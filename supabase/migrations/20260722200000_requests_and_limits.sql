-- Payment requests + per-account daily send limit (Policy Engine)

alter table public.accounts
  add column if not exists daily_send_limit_eth numeric(36, 18)
    check (daily_send_limit_eth is null or daily_send_limit_eth >= 0);

comment on column public.accounts.daily_send_limit_eth is
  'Max total ETH sent per UTC day (on-chain confirmed + claim holds). Null = use app default only (max per-tx still applies).';

create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  requester_account_id uuid not null references public.accounts (id) on delete cascade,
  requester_wa text,
  from_wa_hint text,
  from_label text,
  amount_eth numeric(36, 18) not null check (amount_eth > 0),
  chain_id integer not null,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'cancelled')),
  paid_by_account_id uuid references public.accounts (id) on delete set null,
  paid_tx_hash text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  cancelled_at timestamptz
);

create index if not exists payment_requests_requester_status_idx
  on public.payment_requests (requester_account_id, status, created_at desc);

create index if not exists payment_requests_from_wa_status_idx
  on public.payment_requests (from_wa_hint, status);

alter table public.payment_requests enable row level security;

comment on table public.payment_requests is
  'flizy request: A asks B for amount. B pays after WA identity match. Cancel anytime while pending.';
