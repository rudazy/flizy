-- Reconciling smart-account sends whose outcome is unknown.
--
-- A UserOp is sent inside an ops `handleOps` transaction. Once that
-- transaction is broadcast, a timeout or RPC failure no longer means "nothing
-- was sent": the money may have moved. The executor now reports every failure
-- as submitted (outcome unknown) or not, and the tx hash is written the moment
-- it is broadcast, so a reconciler can finish the record from the receipt.
--
-- Two records had nowhere to put that hash:
--
--   claim_hold_attempts  A claim row is created only after the hold lands in
--                        escrow, so a hold that timed out after broadcast left
--                        ETH in escrow with no claim. This table holds the
--                        hold's intent (who, what, for whom) from before it is
--                        signed: status 'sending', then 'submitted' with the
--                        hash at broadcast, then 'held' with the claim id, or
--                        'failed' (the receipt shows nothing moved) or
--                        'refused' (the executor refused before sending).
--                        'unknown' is for a row the reconciler cannot settle
--                        on its own (no hash after a crash, or no receipt);
--                        it needs a person.
--
--   transfers.payment_request_id
--                        Links a payment to the request it pays, so a
--                        reconciled transfer can settle its request.
--
-- An unfinished native hold counts toward the daily send limit until it is
-- settled: money may already have left the account.
--
-- claims_hold_tx_hash_unique makes one hold transaction yield at most one
-- claim, so the normal path and the reconciler can never both create one.
--
-- Reachable by service_role only, like every table in public. RLS is on with
-- no policies, so only a role that bypasses RLS can read claim_hold_attempts.
-- Its only SQL reader is daily_native_sent_eth, a security invoker function
-- whose execute grant is service_role only; the app calls it through the
-- service-role client (lib/dailyLimits.js, web/lib/dailyLimits.ts). Nothing
-- else can reach it, so it stays invoker rather than gaining definer rights.
--
-- Idempotent: safe to run twice.

create table if not exists public.claim_hold_attempts (
  id uuid primary key default gen_random_uuid(),
  from_account_id uuid not null references public.accounts (id) on delete cascade,
  chain_id integer not null,
  status text not null default 'sending',
  amount_eth numeric(36, 18) not null,
  asset text not null,
  token_address text,
  nft_token_id text,
  -- The createClaim arguments that are not columns above: recipient kind and
  -- identity, sender phone shown to the recipient, invite attach. Server-built,
  -- never user-supplied JSON.
  claim_args jsonb not null default '{}'::jsonb,
  hold_tx_hash text,
  claim_id uuid references public.claims (id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint claim_hold_attempts_status_check
    check (status in ('sending', 'submitted', 'held', 'failed', 'refused', 'unknown')),
  constraint claim_hold_attempts_hash_check
    check (hold_tx_hash is null or hold_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  constraint claim_hold_attempts_amount_check check (amount_eth > 0),
  constraint claim_hold_attempts_error_check check (error is null or length(error) <= 500)
);

create unique index if not exists claim_hold_attempts_hash_unique
  on public.claim_hold_attempts (hold_tx_hash)
  where hold_tx_hash is not null;

create unique index if not exists claim_hold_attempts_claim_unique
  on public.claim_hold_attempts (claim_id)
  where claim_id is not null;

create index if not exists claim_hold_attempts_open_idx
  on public.claim_hold_attempts (status, created_at)
  where status in ('sending', 'submitted', 'unknown');

drop trigger if exists claim_hold_attempts_set_updated_at on public.claim_hold_attempts;
create trigger claim_hold_attempts_set_updated_at
  before update on public.claim_hold_attempts
  for each row
  execute function public.set_updated_at();

comment on table public.claim_hold_attempts is
  'Claim holds from intent to settled: written before signing, hash at broadcast, claim id once the hold lands. Reconciled from the receipt when the outcome was unknown.';

alter table public.claim_hold_attempts enable row level security;
revoke all on table public.claim_hold_attempts from public, anon, authenticated;
grant all on table public.claim_hold_attempts to service_role;

-- One claim per hold transaction. Refuse loudly if history already breaks it,
-- rather than half-applying.
do $$
begin
  if exists (
    select 1 from public.claims
    where hold_tx_hash is not null
    group by hold_tx_hash
    having count(*) > 1
  ) then
    raise exception 'claims has duplicate hold_tx_hash values; resolve them before this migration';
  end if;
end
$$;

create unique index if not exists claims_hold_tx_hash_unique
  on public.claims (hold_tx_hash)
  where hold_tx_hash is not null;

alter table public.transfers
  add column if not exists payment_request_id uuid references public.payment_requests (id) on delete set null;

comment on column public.transfers.payment_request_id is
  'The payment request this transfer pays, so a reconciled transfer can settle it.';

create index if not exists transfers_submitted_idx
  on public.transfers (created_at)
  where status = 'submitted';

create or replace function public.daily_native_sent_eth(p_account_id uuid)
returns text
language sql
stable
set search_path = public
as $$
  with day_start as (
    select (date_trunc('day', now() at time zone 'utc') at time zone 'utc') as since
  )
  select (
    coalesce((
      select sum(t.amount_eth)
      from public.transfers t, day_start d
      where t.account_id = p_account_id
        and t.created_at >= d.since
        and t.status in ('pending', 'submitted', 'confirmed')
        and upper(coalesce(t.asset, 'ETH')) in ('ETH', 'NATIVE', 'ETHER')
        and coalesce(t.kind, 'transfer') <> 'swap'
        and coalesce(t.direction, 'out') = 'out'
    ), 0)
    +
    coalesce((
      select sum(c.amount_eth)
      from public.claims c, day_start d
      where c.from_account_id = p_account_id
        and c.created_at >= d.since
        and c.status in ('pending', 'processing', 'claimed')
        and upper(coalesce(c.asset, 'ETH')) in ('ETH', 'NATIVE', 'ETHER')
    ), 0)
    +
    coalesce((
      select sum(a.amount_eth)
      from public.claim_hold_attempts a, day_start d
      where a.from_account_id = p_account_id
        and a.created_at >= d.since
        and a.status in ('sending', 'submitted', 'unknown')
        and a.claim_id is null
        and upper(coalesce(a.asset, 'ETH')) in ('ETH', 'NATIVE', 'ETHER')
    ), 0)
  )::text;
$$;

comment on function public.daily_native_sent_eth(uuid) is
  'Native ETH sent today (UTC) by one account: outgoing non-swap transfers, claim holds, and holds not yet settled. Daily send limit.';

revoke all on function public.daily_native_sent_eth(uuid) from public, anon, authenticated;
grant execute on function public.daily_native_sent_eth(uuid) to service_role;

do $$
begin
  if to_regclass('public.claim_hold_attempts') is null then
    raise exception 'claim_hold_attempts is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'transfers' and column_name = 'payment_request_id'
  ) then
    raise exception 'transfers.payment_request_id is missing';
  end if;

  if to_regclass('public.claims_hold_tx_hash_unique') is null then
    raise exception 'claims_hold_tx_hash_unique is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'claim_hold_attempts_set_updated_at'
      and tgrelid = 'public.claim_hold_attempts'::regclass
      and not tgisinternal
  ) then
    raise exception 'claim_hold_attempts_set_updated_at trigger is missing';
  end if;

  if has_table_privilege('anon', 'public.claim_hold_attempts', 'select')
     or has_table_privilege('authenticated', 'public.claim_hold_attempts', 'select') then
    raise exception 'claim_hold_attempts is readable by anon or authenticated';
  end if;

  if has_function_privilege('anon', 'public.daily_native_sent_eth(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.daily_native_sent_eth(uuid)', 'execute') then
    raise exception 'daily_native_sent_eth is executable by anon or authenticated';
  end if;
end
$$;
