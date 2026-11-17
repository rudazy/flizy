-- Rewards: what each account earned from the fees in the ledger.
--
-- Rewards are worked out from charged fees (fee_ledger) by the rewards worker
-- on the bot (lib/rewards.js), once per fee:
--
--   fee_ledger.rewards_at   set, from null, by the one run that records a
--                           fee's rewards (record_fee_rewards). A fee whose
--                           rewards are recorded is never counted again.
--   reward_entries          one row per account rewarded for a fee, and kind:
--                             cashback   the account that paid the fee
--                             referral   the account that invited the payer
--                                        (or the business), once the invite
--                                        was counted
--                             merchant   the business whose sale carried a
--                                        merchant fee
--                             adjustment a correction written by hand
--                           Never edited; a correction is an adjustment row.
--   usd_micro               the reward in micro-USD (USD x 1,000,000)
--   from_account_id         for a referral, the account whose fee it came from
--
-- The rates are server settings and are not stored here.
-- Service role only. Idempotent. A partial apply fails the post-condition.

alter table public.fee_ledger add column if not exists rewards_at timestamptz;

comment on column public.fee_ledger.rewards_at is
  'When the rewards for this fee were recorded. Set once, by record_fee_rewards.';

create index if not exists fee_ledger_rewards_due_idx
  on public.fee_ledger (settled_at)
  where state = 'charged' and rewards_at is null;

create table if not exists public.reward_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  kind text not null,
  usd_micro bigint not null,
  fee_ledger_id uuid references public.fee_ledger (id) on delete restrict,
  from_account_id uuid references public.accounts (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint reward_entries_kind_check check (kind in ('cashback', 'referral', 'merchant', 'adjustment')),
  constraint reward_entries_fee_check check (kind = 'adjustment' or (fee_ledger_id is not null and usd_micro > 0)),
  constraint reward_entries_fee_kind_unique unique (fee_ledger_id, kind)
);

create index if not exists reward_entries_account_idx on public.reward_entries (account_id, created_at desc);

comment on table public.reward_entries is
  'Rewards each account earned from charged fees, one row per fee and kind, never edited.';

alter table public.reward_entries enable row level security;
revoke all on table public.reward_entries from public, anon, authenticated;
grant all on table public.reward_entries to service_role;

-- A fee's rewards, recorded in one statement with the fee marked as done, so a
-- crash never leaves part of them and a second run records nothing. Returns
-- false when the fee is not charged or its rewards are already recorded.
create or replace function public.record_fee_rewards(p_fee_id uuid, p_entries jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'record_fee_rewards: entries must be an array';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_entries) as e(kind text)
    where e.kind is null or e.kind not in ('cashback', 'referral', 'merchant')
  ) then
    raise exception 'record_fee_rewards: entries must be cashback, referral or merchant';
  end if;

  update public.fee_ledger
     set rewards_at = now()
   where id = p_fee_id and state = 'charged' and rewards_at is null;
  if not found then
    return false;
  end if;

  insert into public.reward_entries (account_id, kind, usd_micro, fee_ledger_id, from_account_id)
  select e.account_id, e.kind, e.usd_micro, p_fee_id, e.from_account_id
    from jsonb_to_recordset(p_entries) as e(account_id uuid, kind text, usd_micro bigint, from_account_id uuid)
  on conflict (fee_ledger_id, kind) do nothing;
  return true;
end;
$$;

revoke all on function public.record_fee_rewards(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_fee_rewards(uuid, jsonb) to service_role;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'fee_ledger' and column_name = 'rewards_at'
  ) then
    raise exception 'fee_ledger.rewards_at is missing';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'fee_ledger_rewards_due_idx') then
    raise exception 'fee_ledger_rewards_due_idx is missing';
  end if;
  if not exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'reward_entries'
  ) then
    raise exception 'reward_entries is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reward_entries_fee_kind_unique') then
    raise exception 'reward_entries_fee_kind_unique is missing';
  end if;
  if (select relrowsecurity from pg_class where oid = 'public.reward_entries'::regclass) is not true then
    raise exception 'reward_entries has no row level security';
  end if;
  if not exists (select 1 from pg_proc where proname = 'record_fee_rewards') then
    raise exception 'function record_fee_rewards is missing';
  end if;
  if has_function_privilege('anon', 'public.record_fee_rewards(uuid, jsonb)', 'execute') then
    raise exception 'record_fee_rewards is callable by anon';
  end if;
end
$$;
