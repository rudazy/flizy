-- Atomic spend of internal credit.
--
-- The send path used to read balance_eth, send on-chain, then write back an
-- absolute value computed from the stale read. Two sends from two channels both
-- read the same starting balance and the second overwrote the first, so one
-- debit vanished and the user spent credit they no longer had.
--
-- This does the read, the guard and the write in one statement. The WHERE
-- clause is the guard: a row is only updated when it can actually cover the
-- amount, so the balance can never go negative and concurrent debits queue on
-- the row lock instead of clobbering each other.
--
-- Admin top-ups are NOT routed through here. Setting a balance to an absolute
-- value is a different operation and stays a plain update.

create or replace function public.debit_user_balance(
  p_user_id uuid,
  p_amount numeric
)
returns table (success boolean, new_balance numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'debit amount must be greater than 0';
  end if;

  update public.users u
     set balance_eth = u.balance_eth - p_amount,
         updated_at = now()
   where u.id = p_user_id
     and u.balance_eth >= p_amount
  returning u.balance_eth into v_balance;

  if found then
    return query select true, v_balance;
    return;
  end if;

  -- Either no such user, or the balance could not cover it. Report the current
  -- balance so the caller can render a useful message.
  select u.balance_eth into v_balance from public.users u where u.id = p_user_id;
  return query select false, coalesce(v_balance, 0::numeric);
end;
$$;

-- Give credit back when a send was reserved but never left the building.
--
-- Deliberately unguarded: returning what we already took must never fail the
-- way a spend can, or a failed transfer would silently keep the user's money.
create or replace function public.credit_user_balance(
  p_user_id uuid,
  p_amount numeric
)
returns table (success boolean, new_balance numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'credit amount must be greater than 0';
  end if;

  update public.users u
     set balance_eth = u.balance_eth + p_amount,
         updated_at = now()
   where u.id = p_user_id
  returning u.balance_eth into v_balance;

  return query select found, coalesce(v_balance, 0::numeric);
end;
$$;

revoke all on function public.debit_user_balance(uuid, numeric) from public;
revoke all on function public.debit_user_balance(uuid, numeric) from anon;
revoke all on function public.debit_user_balance(uuid, numeric) from authenticated;
grant execute on function public.debit_user_balance(uuid, numeric) to service_role;

revoke all on function public.credit_user_balance(uuid, numeric) from public;
revoke all on function public.credit_user_balance(uuid, numeric) from anon;
revoke all on function public.credit_user_balance(uuid, numeric) from authenticated;
grant execute on function public.credit_user_balance(uuid, numeric) to service_role;

comment on function public.debit_user_balance(uuid, numeric) is
  'Atomic guarded debit of users.balance_eth. Returns success=false and the current balance when the row cannot cover the amount. Service role only: the bot spends credit, clients never do.';

comment on function public.credit_user_balance(uuid, numeric) is
  'Atomic increment of users.balance_eth. Used to return a reservation when a send never reached the chain.';
