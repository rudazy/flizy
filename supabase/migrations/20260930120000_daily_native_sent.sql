-- Today's native ETH sent by one account, for the daily send limit.
--
-- The limit is an ETH limit. transfers.amount_eth and claims.amount_eth hold
-- the human amount in whatever asset the row names, so only native rows count.
-- Swaps do not consume the limit (evaluateSwapPolicy in lib/engine/policy.js):
-- the value stays in the wallet as another asset. Only outgoing rows count.
--
-- Chat (lib/dailyLimits.js) and the site (web/lib/dailyLimits.ts) both call
-- this, so the rule has one definition. It returns text so all 18 decimals
-- survive the trip through JSON. The day is the UTC day. Re-running is safe.

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
  )::text;
$$;

comment on function public.daily_native_sent_eth(uuid) is
  'Native ETH sent today (UTC) by one account: outgoing non-swap transfers plus claim holds. Daily send limit.';

revoke all on function public.daily_native_sent_eth(uuid) from public, anon, authenticated;
grant execute on function public.daily_native_sent_eth(uuid) to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'daily_native_sent_eth'
      and pg_get_function_identity_arguments(p.oid) = 'p_account_id uuid'
  ) then
    raise exception 'daily_native_sent_eth(uuid) is missing';
  end if;

  if has_function_privilege('anon', 'public.daily_native_sent_eth(uuid)', 'execute') then
    raise exception 'daily_native_sent_eth is executable by anon';
  end if;
end
$$;
