-- Savings is a spending fence on the one Flizy wallet.
--
-- The chain balance is everything the wallet holds. A row here is the part
-- the account moved out of Available. Available is the chain balance minus
-- this amount, worked out when it is read. Nothing in this table is a second
-- wallet, a bank balance, or yield.
--
-- The move is one locked update of the reserve row. Callers hold the
-- per-account payment lock around this call. This function does not.
-- Service role only. Idempotent. A partial apply fails the post-condition.

create table if not exists public.account_reserves (
  account_id uuid not null references public.accounts (id) on delete cascade,
  asset text not null,
  amount text not null,
  updated_at timestamptz not null default now(),
  primary key (account_id, asset),
  constraint account_reserves_asset_check check (asset ~ '^[A-Z][A-Z0-9]{0,15}$'),
  constraint account_reserves_amount_check check (amount ~ '^[0-9]+$' and amount <> '0')
);

alter table public.account_reserves enable row level security;
revoke all on table public.account_reserves from anon, authenticated;
grant all on table public.account_reserves to service_role;

comment on table public.account_reserves is
  'Base units of one asset set aside from Available. Not a second wallet and not yield. Service role only.';

create or replace function public.move_account_reserve(
  p_account_id uuid,
  p_asset text,
  p_amount text,
  p_direction text,
  p_holding text,
  p_gas text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_amount numeric(78, 0);
  next_amount numeric(78, 0);
  moving numeric(78, 0);
  holding numeric(78, 0);
  gas_keep numeric(78, 0);
begin
  if p_account_id is null then
    raise exception 'bad reserve move';
  end if;
  if p_asset is null or p_asset !~ '^[A-Z][A-Z0-9]{0,15}$' then
    raise exception 'bad reserve move';
  end if;
  if p_direction is null or p_direction not in ('to_savings', 'to_spending') then
    raise exception 'bad reserve move';
  end if;
  if p_amount is null or p_amount !~ '^[0-9]+$'
     or p_holding is null or p_holding !~ '^[0-9]+$'
     or p_gas is null or p_gas !~ '^[0-9]+$' then
    raise exception 'bad reserve move';
  end if;

  moving := p_amount::numeric(78, 0);
  holding := p_holding::numeric(78, 0);
  gas_keep := p_gas::numeric(78, 0);
  if moving <= 0 or holding < 0 or gas_keep < 0 then
    raise exception 'bad reserve move';
  end if;

  perform pg_advisory_xact_lock(hashtext('flizy.reserve:' || p_account_id::text || ':' || p_asset));

  select r.amount::numeric(78, 0) into current_amount
  from public.account_reserves r
  where r.account_id = p_account_id and r.asset = p_asset
  for update;

  if current_amount is null then
    current_amount := 0;
  end if;

  if p_direction = 'to_savings' then
    next_amount := current_amount + moving;
    if next_amount + gas_keep > holding then
      raise exception 'insufficient available';
    end if;
  else
    if moving > current_amount then
      raise exception 'insufficient savings';
    end if;
    next_amount := current_amount - moving;
  end if;

  if next_amount = 0 then
    delete from public.account_reserves
    where account_id = p_account_id and asset = p_asset;
  else
    insert into public.account_reserves (account_id, asset, amount, updated_at)
    values (p_account_id, p_asset, next_amount::text, now())
    on conflict (account_id, asset)
    do update set amount = excluded.amount, updated_at = now();
  end if;

  return next_amount::text;
end;
$$;

revoke all on function public.move_account_reserve(uuid, text, text, text, text, text) from public;
revoke all on function public.move_account_reserve(uuid, text, text, text, text, text) from anon, authenticated;
grant execute on function public.move_account_reserve(uuid, text, text, text, text, text) to service_role;

comment on function public.move_account_reserve(uuid, text, text, text, text, text) is
  'Move base units between Available and Savings for one asset. Refuses a move that would leave Available short of the gas keep, or a move back larger than Savings.';

do $$
begin
  if to_regclass('public.account_reserves') is null then
    raise exception 'public.account_reserves is missing';
  end if;
  if to_regprocedure('public.move_account_reserve(uuid, text, text, text, text, text)') is null then
    raise exception 'function move_account_reserve is missing';
  end if;
  if has_table_privilege('anon', 'public.account_reserves', 'select')
     or has_table_privilege('authenticated', 'public.account_reserves', 'select') then
    raise exception 'account_reserves is readable by anon or authenticated';
  end if;
  if has_function_privilege('anon', 'public.move_account_reserve(uuid, text, text, text, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.move_account_reserve(uuid, text, text, text, text, text)', 'execute') then
    raise exception 'move_account_reserve is executable by anon or authenticated';
  end if;
end;
$$;
