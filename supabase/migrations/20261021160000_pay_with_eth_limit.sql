-- Paying a token amount with ETH counts against the daily ETH limit.
--
-- POST /api/pay/swap pays a tUSD or FLZ amount by swapping the payer's ETH,
-- with the payee as the swap's recipient. Its transfers row names the token,
-- because that is what the payee received, so daily_native_sent_eth, which
-- counts only ETH rows, would not see the ETH that left. A route that moves
-- ETH out of the account without consuming the limit is a way around it.
--
-- 1. transfers.eth_in: the ETH an outgoing token payment was funded with.
--    Typed, unlike amount_secondary, which is display text.
-- 2. daily_native_sent_eth adds eth_in for outgoing payments, alongside the
--    native rows and claim holds it already counts. Swaps stay out: their
--    value stays in the wallet, and they never set eth_in.
--
-- Idempotent: safe to run twice.

alter table public.transfers
  add column if not exists eth_in numeric(36, 18);

alter table public.transfers drop constraint if exists transfers_eth_in_check;
alter table public.transfers
  add constraint transfers_eth_in_check check (eth_in is null or eth_in > 0);

comment on column public.transfers.eth_in is
  'ETH the sender spent to fund this token payment (pay with ETH). Counted by daily_native_sent_eth.';

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
      select sum(t.eth_in)
      from public.transfers t, day_start d
      where t.account_id = p_account_id
        and t.created_at >= d.since
        and t.status in ('pending', 'submitted', 'confirmed')
        and t.eth_in is not null
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
  'Native ETH sent today (UTC) by one account: outgoing non-swap transfers, ETH that funded token payments, claim holds, and holds not yet settled. Daily send limit.';

revoke all on function public.daily_native_sent_eth(uuid) from public, anon, authenticated;
grant execute on function public.daily_native_sent_eth(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Post-conditions: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'transfers' and column_name = 'eth_in'
  ) then
    raise exception 'transfers.eth_in is missing';
  end if;
  if position('eth_in' in pg_get_functiondef('public.daily_native_sent_eth(uuid)'::regprocedure)) = 0 then
    raise exception 'daily_native_sent_eth does not count eth_in';
  end if;
end
$$;
