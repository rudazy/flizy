-- Known recipients and the quick-send amount.
--
-- A small ETH payment to someone the account already pays is approved with a
-- plain confirm; anything else takes the PIN. Two things decide it:
--
--   accounts.quick_send_eth   the most one payment may be without the PIN.
--                             null means the app default (DEFAULT_QUICK_SEND_ETH,
--                             read in lib/tiers.js and web/lib/tiers.ts); 0
--                             means the PIN for every payment.
--
--   known_recipients          one row per (account, address) this account has
--                             paid: a confirmed outgoing transfer of kind
--                             'transfer', which covers sends, pay codes,
--                             payment requests and pot contributions. Swaps,
--                             marketplace rows, mints and claim holds are other
--                             kinds and never add a row. Addresses are stored
--                             lower case.
--
-- A trigger on transfers keeps the table current, so chat and the site cannot
-- record payments differently. Existing history is backfilled once below.
--
-- is_known_recipient(account, address) is the one definition of "known":
--   * on the trusted list, active and past its 24 hour hold, or
--   * first paid at least 1 hour ago, and last paid within 180 days.
-- The hour stops a thief who pays themselves once from turning that into
-- PIN-free payments straight away. 180 days keeps the list to people the
-- account still pays.
--
-- Reachable by service_role only, like every table in public.
--
-- Idempotent: safe to run twice.

alter table public.accounts
  add column if not exists quick_send_eth numeric(36, 18);

alter table public.accounts
  drop constraint if exists accounts_quick_send_eth_check;
alter table public.accounts
  add constraint accounts_quick_send_eth_check
  check (quick_send_eth is null or quick_send_eth >= 0);

comment on column public.accounts.quick_send_eth is
  'Most one ETH payment to a known recipient may be without the PIN. null = app default, 0 = always the PIN.';

create table if not exists public.known_recipients (
  account_id uuid not null references public.accounts (id) on delete cascade,
  address text not null,
  first_paid_at timestamptz not null,
  last_paid_at timestamptz not null,
  payments integer not null default 1,
  constraint known_recipients_pkey primary key (account_id, address),
  constraint known_recipients_address_check check (address ~ '^0x[0-9a-f]{40}$'),
  constraint known_recipients_payments_check check (payments > 0)
);

comment on table public.known_recipients is
  'Addresses each account has paid (confirmed outgoing transfers of kind transfer). Read through is_known_recipient.';

alter table public.known_recipients enable row level security;
revoke all on table public.known_recipients from public, anon, authenticated;
grant all on table public.known_recipients to service_role;

-- Backfill before the trigger exists, so no payment is counted twice.
insert into public.known_recipients (account_id, address, first_paid_at, last_paid_at, payments)
select
  t.account_id,
  lower(t.to_address),
  min(t.created_at),
  max(t.created_at),
  count(*)::integer
from public.transfers t
join public.accounts a on a.id = t.account_id
where t.status = 'confirmed'
  and coalesce(t.kind, 'transfer') = 'transfer'
  and coalesce(t.direction, 'out') = 'out'
  and t.to_address ~* '^0x[0-9a-f]{40}$'
  and lower(t.to_address) <> '0x0000000000000000000000000000000000000000'
group by t.account_id, lower(t.to_address)
on conflict (account_id, address) do nothing;

create or replace function public.record_known_recipient()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status <> 'confirmed'
     or new.account_id is null
     or coalesce(new.kind, 'transfer') <> 'transfer'
     or coalesce(new.direction, 'out') <> 'out'
     or new.to_address !~* '^0x[0-9a-f]{40}$'
     or lower(new.to_address) = '0x0000000000000000000000000000000000000000' then
    return new;
  end if;
  -- An update that leaves a row confirmed is not a second payment.
  if tg_op = 'UPDATE' and old.status = 'confirmed' then
    return new;
  end if;

  insert into public.known_recipients (account_id, address, first_paid_at, last_paid_at, payments)
  values (new.account_id, lower(new.to_address), now(), now(), 1)
  on conflict (account_id, address) do update
    set last_paid_at = greatest(public.known_recipients.last_paid_at, excluded.last_paid_at),
        payments = public.known_recipients.payments + 1;
  return new;
end;
$$;

revoke all on function public.record_known_recipient() from public, anon, authenticated;

drop trigger if exists transfers_record_known_recipient on public.transfers;
create trigger transfers_record_known_recipient
  after insert or update of status on public.transfers
  for each row
  execute function public.record_known_recipient();

create or replace function public.is_known_recipient(p_account_id uuid, p_address text)
returns boolean
language sql
stable
set search_path = public
as $$
  select
    exists (
      select 1
      from public.trusted_addresses ta
      where ta.account_id = p_account_id
        and lower(ta.address) = lower(p_address)
        and ta.status = 'active'
        and ta.active_at <= now()
    )
    or exists (
      select 1
      from public.known_recipients kr
      where kr.account_id = p_account_id
        and kr.address = lower(p_address)
        and kr.first_paid_at <= now() - interval '1 hour'
        and kr.last_paid_at >= now() - interval '180 days'
    );
$$;

comment on function public.is_known_recipient(uuid, text) is
  'True when the address is on the usable trusted list, or was first paid over an hour ago and last paid within 180 days.';

revoke all on function public.is_known_recipient(uuid, text) from public, anon, authenticated;
grant execute on function public.is_known_recipient(uuid, text) to service_role;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'accounts' and column_name = 'quick_send_eth'
  ) then
    raise exception 'accounts.quick_send_eth is missing';
  end if;

  if to_regclass('public.known_recipients') is null then
    raise exception 'known_recipients is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'transfers_record_known_recipient'
      and tgrelid = 'public.transfers'::regclass
      and not tgisinternal
  ) then
    raise exception 'transfers_record_known_recipient trigger is missing';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'is_known_recipient'
      and pg_get_function_identity_arguments(p.oid) = 'p_account_id uuid, p_address text'
  ) then
    raise exception 'is_known_recipient(uuid, text) is missing';
  end if;

  if has_function_privilege('anon', 'public.is_known_recipient(uuid, text)', 'execute') then
    raise exception 'is_known_recipient is executable by anon';
  end if;

  if has_table_privilege('anon', 'public.known_recipients', 'select') then
    raise exception 'known_recipients is readable by anon';
  end if;
end
$$;
