-- Activity feed enrichment: multi-asset history, nullable phone for account-scoped rows

alter table public.transfers
  alter column phone drop not null;

alter table public.transfers
  add column if not exists asset text default 'ETH',
  add column if not exists token_address text,
  add column if not exists counterparty_label text,
  add column if not exists direction text default 'out',
  add column if not exists amount_secondary text,
  add column if not exists asset_secondary text;

comment on column public.transfers.asset is 'Primary asset symbol (ETH, FLZ, …)';
comment on column public.transfers.direction is 'out = leave wallet, in = enter wallet';
comment on column public.transfers.amount_secondary is 'e.g. swap output amount as display string';
comment on column public.transfers.asset_secondary is 'e.g. swap output symbol';

create index if not exists transfers_account_created_idx
  on public.transfers (account_id, created_at desc);
