-- One-tap faucet: test ETH sent from a Flizy-run dispenser wallet straight to
-- the claiming account's Flizy wallet, at most once per cooldown.
--
-- 1. faucet_claims is the record of every claim, and the cooldown is read from
--    it. A failed claim does not count. A claim left pending for more than five
--    minutes with no transaction is treated as abandoned (the request died
--    before sending), so a crash cannot lock somebody out for the whole
--    cooldown.
-- 2. try_faucet_claim decides and reserves in one statement under a
--    per-account advisory lock, so two clicks at the same instant produce one
--    claim, not two.
-- 3. faucet_signer_lock serialises sends from the one dispenser wallet across
--    serverless requests, so two people claiming at once do not race on the
--    wallet's nonce. The holder token makes release drop only its own lock; a
--    lock older than two minutes is treated as left behind by a crash.
--
-- Service role only. Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Claims
-- ---------------------------------------------------------------------------

create table if not exists public.faucet_claims (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  to_address text not null,
  amount_wei numeric(78, 0) not null,
  status text not null default 'pending',
  tx_hash text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint faucet_claims_status_check check (status in ('pending', 'sent', 'confirmed', 'failed')),
  constraint faucet_claims_amount_check check (amount_wei > 0),
  constraint faucet_claims_to_address_check check (to_address ~ '^0x[0-9a-fA-F]{40}$'),
  constraint faucet_claims_tx_hash_check check (tx_hash is null or tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  constraint faucet_claims_error_len check (error is null or char_length(error) <= 300)
);

create index if not exists faucet_claims_account_idx on public.faucet_claims (account_id, created_at desc);

alter table public.faucet_claims enable row level security;
revoke all on table public.faucet_claims from anon, authenticated;
grant all on table public.faucet_claims to service_role;

comment on table public.faucet_claims is
  'One row per faucet claim. Failed and abandoned claims do not count toward the cooldown. Service role only.';

-- ---------------------------------------------------------------------------
-- 2. Reserve a claim
-- ---------------------------------------------------------------------------

create or replace function public.try_faucet_claim(
  p_account_id uuid,
  p_to text,
  p_amount_wei numeric,
  p_cooldown_hours integer
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
  if p_account_id is null or p_cooldown_hours is null or p_cooldown_hours < 1 then
    raise exception 'try_faucet_claim: bad arguments';
  end if;

  perform pg_advisory_xact_lock(hashtext('flizy.faucet:' || p_account_id::text));

  select max(c.created_at) into last_at
  from public.faucet_claims c
  where c.account_id = p_account_id
    and c.created_at > now() - make_interval(hours => p_cooldown_hours)
    and c.status <> 'failed'
    and not (c.status = 'pending' and c.tx_hash is null and c.created_at < now() - interval '5 minutes');

  if last_at is not null then
    return query select null::uuid, last_at + make_interval(hours => p_cooldown_hours);
    return;
  end if;

  insert into public.faucet_claims (account_id, to_address, amount_wei)
  values (p_account_id, p_to, p_amount_wei)
  returning id into new_id;

  return query select new_id, now() + make_interval(hours => p_cooldown_hours);
end
$$;

revoke all on function public.try_faucet_claim(uuid, text, numeric, integer) from public;
revoke all on function public.try_faucet_claim(uuid, text, numeric, integer) from anon, authenticated;
grant execute on function public.try_faucet_claim(uuid, text, numeric, integer) to service_role;

comment on function public.try_faucet_claim(uuid, text, numeric, integer) is
  'Reserve a faucet claim, or return when the next one is allowed. One claim per account per cooldown.';

-- ---------------------------------------------------------------------------
-- 3. One send at a time from the dispenser wallet
-- ---------------------------------------------------------------------------

create table if not exists public.faucet_signer_lock (
  id smallint primary key default 1,
  holder uuid not null,
  created_at timestamptz not null default now(),
  constraint faucet_signer_lock_single check (id = 1)
);

alter table public.faucet_signer_lock enable row level security;
revoke all on table public.faucet_signer_lock from anon, authenticated;
grant all on table public.faucet_signer_lock to service_role;

create or replace function public.try_faucet_signer_lock(p_holder uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_holder is null then
    return false;
  end if;

  delete from public.faucet_signer_lock where created_at < now() - interval '2 minutes';

  begin
    insert into public.faucet_signer_lock (id, holder) values (1, p_holder);
    return true;
  exception
    when unique_violation then
      return false;
  end;
end
$$;

create or replace function public.release_faucet_signer_lock(p_holder uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.faucet_signer_lock where holder = p_holder;
end
$$;

revoke all on function public.try_faucet_signer_lock(uuid) from public;
revoke all on function public.try_faucet_signer_lock(uuid) from anon, authenticated;
grant execute on function public.try_faucet_signer_lock(uuid) to service_role;

revoke all on function public.release_faucet_signer_lock(uuid) from public;
revoke all on function public.release_faucet_signer_lock(uuid) from anon, authenticated;
grant execute on function public.release_faucet_signer_lock(uuid) to service_role;

comment on function public.try_faucet_signer_lock(uuid) is
  'Take the dispenser send lock. False while another request holds it.';
comment on function public.release_faucet_signer_lock(uuid) is
  'Drop the dispenser send lock, only if this holder still has it.';

-- ---------------------------------------------------------------------------
-- Post-conditions: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.faucet_claims') is null then
    raise exception 'public.faucet_claims is missing';
  end if;
  if to_regclass('public.faucet_signer_lock') is null then
    raise exception 'public.faucet_signer_lock is missing';
  end if;
  if to_regprocedure('public.try_faucet_claim(uuid, text, numeric, integer)') is null then
    raise exception 'function try_faucet_claim is missing';
  end if;
  if to_regprocedure('public.try_faucet_signer_lock(uuid)') is null then
    raise exception 'function try_faucet_signer_lock is missing';
  end if;
  if to_regprocedure('public.release_faucet_signer_lock(uuid)') is null then
    raise exception 'function release_faucet_signer_lock is missing';
  end if;
end
$$;
