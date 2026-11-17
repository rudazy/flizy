-- Rewards: an account's balance.
--
-- The sum of an account's reward_entries (migration 20261117120000_rewards.sql),
-- in micro-USD, worked out in the database so an account with many entries is
-- never read row by row. 0 for an account with none. Read by the chat command
-- and Account > Rewards (lib/rewardsView.js).
--
-- Service role only. Idempotent. A partial apply fails the post-condition.

create or replace function public.reward_balance(p_account_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(usd_micro), 0)::bigint
    from public.reward_entries
   where account_id = p_account_id;
$$;

revoke all on function public.reward_balance(uuid) from public, anon, authenticated;
grant execute on function public.reward_balance(uuid) to service_role;

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'reward_balance') then
    raise exception 'function reward_balance is missing';
  end if;
  if has_function_privilege('anon', 'public.reward_balance(uuid)', 'execute') then
    raise exception 'reward_balance is callable by anon';
  end if;
end
$$;
