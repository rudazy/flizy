-- Flizy Pay API, phase 2a: direct payouts from a platform's wallet.
--
-- api_platform_limits  Flizy's caps per platform and asset: the most one payout
--                      may move and the most a rolling day may move, in the
--                      asset's base units. No row means that asset is refused.
--                      Also the period amount of the platform's allowance.
-- api_allowances       the platform's passkey-signed period allowance per asset,
--                      delegated to the API relayer (API_RELAYER_KEY). The only
--                      way an API payout spends: the owner key is never used.
-- api_transactions     gains the resolved address, the transfers row, and a
--                      worker lease.
-- api_claim_payout()   hands the VPS worker one payout at a time.
--
-- Service role only. Idempotent. A partial apply fails the post-condition.

create table if not exists public.api_platform_limits (
  platform_id uuid not null references public.api_platforms (id) on delete cascade,
  symbol text not null,
  max_payout text not null,
  daily_max text not null,
  updated_at timestamptz not null default now(),
  primary key (platform_id, symbol),
  constraint api_platform_limits_symbol_check check (symbol in ('ETH', 'FLZ', 'TUSD')),
  constraint api_platform_limits_amounts_check check (
    max_payout ~ '^[1-9][0-9]{0,77}$' and daily_max ~ '^[1-9][0-9]{0,77}$'
    and max_payout::numeric <= daily_max::numeric
  )
);

create table if not exists public.api_allowances (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references public.api_platforms (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  symbol text not null,
  gator text not null,
  delegate text not null,
  salt text not null,
  period_amount text not null,
  signed_at timestamptz not null,
  expires_at timestamptz not null,
  digest text not null,
  caveats jsonb not null,
  signature text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  constraint api_allowances_symbol_check check (symbol in ('ETH', 'FLZ', 'TUSD')),
  constraint api_allowances_address_check check (gator ~ '^0x[0-9a-fA-F]{40}$' and delegate ~ '^0x[0-9a-fA-F]{40}$'),
  constraint api_allowances_salt_check check (salt ~ '^[1-9][0-9]{0,77}$'),
  constraint api_allowances_amount_check check (period_amount ~ '^[1-9][0-9]{0,77}$'),
  constraint api_allowances_digest_check check (digest ~ '^0x[0-9a-f]{64}$'),
  constraint api_allowances_status_check check (status in ('pending', 'active', 'replaced')),
  constraint api_allowances_signed_check check (status = 'pending' or signature ~ '^0x[0-9a-f]+$')
);
create unique index if not exists api_allowances_digest_once on public.api_allowances (digest);
-- At most one live allowance per asset per platform.
create unique index if not exists api_allowances_one_active
  on public.api_allowances (platform_id, symbol) where status = 'active';

alter table public.api_transactions add column if not exists to_address text;
alter table public.api_transactions add column if not exists transfer_id uuid references public.transfers (id) on delete set null;
alter table public.api_transactions add column if not exists lease_until timestamptz;
alter table public.api_transactions add column if not exists attempts integer not null default 0;
alter table public.api_transactions add column if not exists metadata jsonb;
create index if not exists api_transactions_work_idx
  on public.api_transactions (state, created_at) where kind = 'payout' and state in ('accepted', 'queued', 'submitted');

-- One payout for the worker: the oldest accepted one (moved to queued, with its
-- webhook event, through api_transition), or a queued one whose lease ran out
-- before any transaction hash was recorded. A hash is recorded before every
-- broadcast, so no hash means nothing was sent and taking it again is safe.
-- skip locked: two workers never take the same row.
create or replace function public.api_claim_payout(p_lease_seconds integer)
returns setof public.api_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  picked public.api_transactions;
begin
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 900 then
    raise exception 'lease must be 10 to 900 seconds';
  end if;
  select * into picked
  from public.api_transactions
  where kind = 'payout'
    and (
      state = 'accepted'
      or (state = 'queued' and tx_hash is null and (lease_until is null or lease_until < now()))
    )
  order by created_at
  limit 1
  for update skip locked;
  if picked.id is null then
    return;
  end if;
  if picked.state = 'accepted' then
    perform public.api_transition(picked.id, 'queued', '{}'::jsonb);
  end if;
  update public.api_transactions
  set lease_until = now() + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1,
      updated_at = now()
  where id = picked.id
  returning * into picked;
  return next picked;
end;
$$;

alter table public.api_platform_limits enable row level security;
alter table public.api_allowances enable row level security;

revoke all on table public.api_platform_limits from anon, authenticated;
revoke all on table public.api_allowances from anon, authenticated;
grant all on table public.api_platform_limits to service_role;
grant all on table public.api_allowances to service_role;
revoke all on function public.api_claim_payout(integer) from public, anon, authenticated;
grant execute on function public.api_claim_payout(integer) to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['api_platform_limits', 'api_allowances'] loop
    if to_regclass('public.' || t) is null then
      raise exception 'public.% is missing', t;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'row level security is off on public.%', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'select') then
      raise exception 'public.% is readable by anon or authenticated', t;
    end if;
  end loop;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'api_transactions' and column_name = 'lease_until'
  ) then
    raise exception 'api_transactions.lease_until is missing';
  end if;
  if to_regprocedure('public.api_claim_payout(integer)') is null then
    raise exception 'function api_claim_payout is missing';
  end if;
  if has_function_privilege('anon', 'public.api_claim_payout(integer)', 'execute')
     or has_function_privilege('authenticated', 'public.api_claim_payout(integer)', 'execute') then
    raise exception 'api_claim_payout is executable by anon or authenticated';
  end if;
  if to_regclass('public.api_allowances_one_active') is null then
    raise exception 'index api_allowances_one_active is missing';
  end if;
end;
$$;
