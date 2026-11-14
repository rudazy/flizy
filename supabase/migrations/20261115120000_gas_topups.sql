-- Gas paid for wallets through their EntryPoint deposit.
--
-- A wallet's UserOp prefund comes out of its EntryPoint deposit before its own
-- ETH. With GAS_TOPUP_ENABLED, a dedicated top-up key (GAS_TOPUP_PRIVATE_KEY,
-- never the ops key) pays EntryPoint.depositTo(wallet) for the shortfall just
-- before the wallet's UserOp, so the wallet needs no ETH for gas
-- (lib/gasTopup.js, mirror web/lib/gasTopup.ts).
--
--   gas_topups   One row per top-up, written before it is sent so a second
--                send counts it against the per-wallet daily cap. pending:
--                about to be sent; sent: the node took it (tx_hash set);
--                failed: nothing was sent, or it reverted. The amount is in
--                wei and, at the configured ETH rate, in micro-USD.
--
-- Testnet stopgap: a deposit can be withdrawn by the wallet's owner, so this is
-- replaced with a paymaster before ownership moves to users.
--
-- Service role only. Idempotent. A partial apply fails the post-condition.

create table if not exists public.gas_topups (
  id uuid primary key default gen_random_uuid(),
  wallet text not null,
  account_id uuid,
  amount_wei numeric(78, 0) not null,
  usd_micro bigint not null,
  status text not null default 'pending',
  tx_hash text,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gas_topups_wallet_check check (wallet ~ '^0x[0-9a-f]{40}$'),
  constraint gas_topups_amount_check check (amount_wei > 0 and usd_micro >= 0),
  constraint gas_topups_status_check check (status in ('pending', 'sent', 'failed')),
  constraint gas_topups_hash_check check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  constraint gas_topups_reason_check check (reason is null or char_length(reason) <= 200)
);

create index if not exists gas_topups_wallet_created_idx on public.gas_topups (wallet, created_at desc);

drop trigger if exists gas_topups_set_updated_at on public.gas_topups;
create trigger gas_topups_set_updated_at
  before update on public.gas_topups
  for each row
  execute function public.set_updated_at();

comment on table public.gas_topups is
  'EntryPoint deposit top-ups Flizy paid so a wallet needs no ETH for gas. Counted against a per-wallet daily cap.';

alter table public.gas_topups enable row level security;
revoke all on table public.gas_topups from public, anon, authenticated;
grant all on table public.gas_topups to service_role;

do $$
begin
  if not exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'gas_topups'
  ) then
    raise exception 'gas_topups is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gas_topups_status_check') then
    raise exception 'gas_topups_status_check is missing';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'gas_topups_wallet_created_idx') then
    raise exception 'gas_topups_wallet_created_idx is missing';
  end if;
  if (select relrowsecurity from pg_class where oid = 'public.gas_topups'::regclass) is not true then
    raise exception 'gas_topups has no row level security';
  end if;
end $$;
