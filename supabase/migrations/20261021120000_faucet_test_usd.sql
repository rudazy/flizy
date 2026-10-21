-- The faucet hands out Flizy Test USD (tUSD) as well as test ETH.
--
-- Each asset has its own cooldown, so a claim of one never holds back the
-- other. faucet_claims gains an asset column; every existing row is ETH.
-- amount_wei keeps its name and holds the smallest unit of whichever asset the
-- row is for: wei for ETH, six-decimal units for tUSD.
--
-- try_faucet_claim gains a fifth argument, the asset, and counts only claims
-- of that asset. The four-argument form stays, as ETH only, so code deployed
-- before this migration reserves exactly as it did.
--
-- The dispenser wallet and its signer lock are shared: a tUSD transfer and an
-- ETH send from the same wallet must not race on its nonce either.
--
-- Service role only. Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Claims carry their asset
-- ---------------------------------------------------------------------------

alter table public.faucet_claims add column if not exists asset text not null default 'ETH';

alter table public.faucet_claims drop constraint if exists faucet_claims_asset_check;
alter table public.faucet_claims
  add constraint faucet_claims_asset_check check (asset in ('ETH', 'TUSD'));

create index if not exists faucet_claims_account_asset_idx
  on public.faucet_claims (account_id, asset, created_at desc);

comment on column public.faucet_claims.asset is
  'ETH or TUSD. amount_wei is in this asset''s smallest unit.';

-- ---------------------------------------------------------------------------
-- 2. Reserve a claim of one asset
-- ---------------------------------------------------------------------------

create or replace function public.try_faucet_claim(
  p_account_id uuid,
  p_to text,
  p_amount_wei numeric,
  p_cooldown_hours integer,
  p_asset text
)
returns table (claim_id uuid, next_claim_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  last_at timestamptz;
  new_id uuid;
begin
  if p_account_id is null or p_cooldown_hours is null or p_cooldown_hours < 1
     or p_asset is null or p_asset not in ('ETH', 'TUSD') then
    raise exception 'try_faucet_claim: bad arguments';
  end if;

  -- The same per-account lock for every asset: two clicks still make one claim.
  perform pg_advisory_xact_lock(hashtext('flizy.faucet:' || p_account_id::text));

  select max(c.created_at) into last_at
  from public.faucet_claims c
  where c.account_id = p_account_id
    and c.asset = p_asset
    and c.created_at > now() - make_interval(hours => p_cooldown_hours)
    and c.status <> 'failed'
    and not (c.status = 'pending' and c.tx_hash is null and c.created_at < now() - interval '5 minutes');

  if last_at is not null then
    return query select null::uuid, last_at + make_interval(hours => p_cooldown_hours);
    return;
  end if;

  insert into public.faucet_claims (account_id, to_address, amount_wei, asset)
  values (p_account_id, p_to, p_amount_wei, p_asset)
  returning id into new_id;

  return query select new_id, now() + make_interval(hours => p_cooldown_hours);
end
$$;

revoke all on function public.try_faucet_claim(uuid, text, numeric, integer, text) from public;
revoke all on function public.try_faucet_claim(uuid, text, numeric, integer, text) from anon, authenticated;
grant execute on function public.try_faucet_claim(uuid, text, numeric, integer, text) to service_role;

comment on function public.try_faucet_claim(uuid, text, numeric, integer, text) is
  'Reserve a faucet claim of one asset, or return when the next one is allowed. One claim per account per asset per cooldown.';

-- The four-argument form, kept for code deployed before this migration: ETH only.
create or replace function public.try_faucet_claim(
  p_account_id uuid,
  p_to text,
  p_amount_wei numeric,
  p_cooldown_hours integer
)
returns table (claim_id uuid, next_claim_at timestamptz)
language sql
security definer
set search_path = public, pg_temp
as $$
  select * from public.try_faucet_claim(p_account_id, p_to, p_amount_wei, p_cooldown_hours, 'ETH');
$$;

revoke all on function public.try_faucet_claim(uuid, text, numeric, integer) from public;
revoke all on function public.try_faucet_claim(uuid, text, numeric, integer) from anon, authenticated;
grant execute on function public.try_faucet_claim(uuid, text, numeric, integer) to service_role;

comment on function public.try_faucet_claim(uuid, text, numeric, integer) is
  'ETH-only form of try_faucet_claim, kept for code deployed before the asset argument.';

-- ---------------------------------------------------------------------------
-- Post-conditions: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'faucet_claims' and column_name = 'asset'
  ) then
    raise exception 'faucet_claims.asset is missing';
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'faucet_claims_asset_check'
  ) then
    raise exception 'faucet_claims_asset_check is missing';
  end if;
  if to_regprocedure('public.try_faucet_claim(uuid, text, numeric, integer, text)') is null then
    raise exception 'function try_faucet_claim(..., text) is missing';
  end if;
  if to_regprocedure('public.try_faucet_claim(uuid, text, numeric, integer)') is null then
    raise exception 'function try_faucet_claim(uuid, text, numeric, integer) is missing';
  end if;
end
$$;
