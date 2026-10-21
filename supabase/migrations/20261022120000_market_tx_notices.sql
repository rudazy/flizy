-- One record per marketplace transaction whose notices went out.
--
-- A Flizy account hears in chat when someone offers on, buys, or accepts an
-- offer for its NFT. Trades made from the Flizy wallet send those notices
-- from the server route. Trades made in wallet mode, by a visitor's own
-- wallet, are announced afterwards: the page hands over the transaction hash
-- and the server reads the marketplace's events from the chain. Either path
-- claims the hash here first, so a transaction is announced once, however
-- many times it is handed over.
--
-- tx_hash is stored lower case. Service role only, like every table in public.
--
-- external_pay_attempts, the per-caller counter the outside-wallet pay route
-- uses, now also caps wallet mode's calls (web/lib/callerLimit.ts), under keys
-- "read:", "plan:" and "notice:" followed by the hashed client address. Only
-- its comment changes here.
--
-- Idempotent: safe to run twice.

create table if not exists public.market_tx_notices (
  tx_hash text primary key,
  created_at timestamptz not null default now(),
  constraint market_tx_notices_hash_check check (tx_hash ~ '^0x[0-9a-f]{64}$')
);

alter table public.market_tx_notices enable row level security;
revoke all on table public.market_tx_notices from anon, authenticated;
grant all on table public.market_tx_notices to service_role;

comment on table public.market_tx_notices is
  'Marketplace transactions whose offer and sale notices were sent, so each is announced once. Service role only.';

comment on table public.external_pay_attempts is
  'One row per capped call from a caller without a Flizy account: outside-wallet pay confirms, and wallet-mode reads, trade plans and notices. Keyed on a hashed client address. Service role only.';

-- ---------------------------------------------------------------------------
-- Post-condition: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.market_tx_notices') is null then
    raise exception 'public.market_tx_notices is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'market_tx_notices_hash_check') then
    raise exception 'market_tx_notices_hash_check is missing';
  end if;
  if coalesce(obj_description('public.external_pay_attempts'::regclass, 'pg_class'), '') not like '%wallet-mode%' then
    raise exception 'external_pay_attempts comment was not updated';
  end if;
end
$$;
