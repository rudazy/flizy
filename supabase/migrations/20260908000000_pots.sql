-- Group collect: a named pot that exists before anyone is asked.
--
-- Split bill deliberately has no table. Its total is the sum of the requests,
-- its creator is the same requester on every one, and its progress is counted
-- from them, so a table would have been a second copy of four facts for the
-- sake of one label. That argument is in
-- 20260907000000_request_platform_recipient.sql, which also named the three
-- conditions that would force a real table:
--
--   a pot that exists before anyone is asked
--   money arriving outside a per-person request
--   renaming a bill after the fact
--
-- A named pot is all three at once, so this is that table.
--
-- Why a pot cannot be a payment_requests row: that table's
-- payment_requests_recipient_mode_check demands exactly one addressing mode per
-- row, because a row matching two match paths would show one bill to two
-- different people. A pot is addressed to nobody. Weakening that constraint to
-- fit a pot would reintroduce exactly the bug it was written to prevent.
--
-- What is still derived, and deliberately not stored here: the running total.
-- There is no balance column. A pot's total is the sum of the contributions
-- pointing at it, counted at read time. A stored total can disagree with the
-- rows it describes; a counted one cannot. Same argument as the frozen credit
-- ledger and as split bill.
--
-- Money model (owner decision, 2026-09-07): a contribution settles straight to
-- the organiser's wallet, exactly like paying a request does today. There is no
-- pot escrow, no refund path and no new solvency invariant. The pot is a ledger
-- of who put in what, not a custodian. Contributors see a running total, not a
-- guarantee. This matches how ajo and esusu already work socially: the money is
-- held by a person you chose to trust.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. The pot
-- ---------------------------------------------------------------------------

create table if not exists public.pots (
  id uuid primary key default gen_random_uuid(),
  owner_account_id uuid not null references public.accounts (id) on delete cascade,
  code text not null,
  name text not null,
  target_eth numeric(36, 18),
  status text not null default 'open',
  chain_id integer,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- 2. Rules the table enforces itself
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pots_status_check'
  ) then
    alter table public.pots
      add constraint pots_status_check
      check (status in ('open', 'closed'));
  end if;

  -- An open pot with a closing time, or a closed pot without one, would make
  -- "is this still collecting" answerable two ways.
  if not exists (
    select 1 from pg_constraint where conname = 'pots_closed_at_check'
  ) then
    alter table public.pots
      add constraint pots_closed_at_check
      check (
        (status = 'open' and closed_at is null)
        or (status = 'closed' and closed_at is not null)
      );
  end if;

  -- A target of zero would report a pot complete before anyone paid into it.
  if not exists (
    select 1 from pg_constraint where conname = 'pots_target_positive_check'
  ) then
    alter table public.pots
      add constraint pots_target_positive_check
      check (target_eth is null or target_eth > 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'pots_name_not_blank_check'
  ) then
    alter table public.pots
      add constraint pots_name_not_blank_check
      check (btrim(name) <> '');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'pots_code_not_blank_check'
  ) then
    alter table public.pots
      add constraint pots_code_not_blank_check
      check (btrim(code) <> '');
  end if;
end
$$;

-- The code is how a pot is named in chat, so it has to be unique across all of
-- them, not merely per owner.
create unique index if not exists pots_code_lower_uidx
  on public.pots (lower(code));

create index if not exists pots_owner_status_idx
  on public.pots (owner_account_id, status, created_at desc);

alter table public.pots enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Contributions are transfers, not a second money record
-- ---------------------------------------------------------------------------

-- A contribution is money that actually moved, and money that moved is already
-- a transfers row. Giving that row a pot_id makes it a contribution; a separate
-- pot_contributions table would store the amount twice and let the two
-- disagree. The pot total is a sum over this column.
alter table public.transfers
  add column if not exists pot_id uuid references public.pots (id) on delete set null;

-- Partial: only contributions carry it, and ordinary sends would bloat the index.
create index if not exists transfers_pot_status_idx
  on public.transfers (pot_id, status)
  where pot_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Post-condition
-- ---------------------------------------------------------------------------

do $$
declare
  missing text;
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'pots'
  ) then
    raise exception 'pots table was not created';
  end if;

  select string_agg(t.name, ', ')
  into missing
  from (values
    ('pots_status_check'),
    ('pots_closed_at_check'),
    ('pots_target_positive_check'),
    ('pots_name_not_blank_check'),
    ('pots_code_not_blank_check')
  ) as t(name)
  where not exists (select 1 from pg_constraint where conname = t.name);

  if missing is not null then
    raise exception 'pot constraints missing: %', missing;
  end if;

  select string_agg(t.name, ', ')
  into missing
  from (values
    ('pots_code_lower_uidx'),
    ('pots_owner_status_idx'),
    ('transfers_pot_status_idx')
  ) as t(name)
  where not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = t.name
  );

  if missing is not null then
    raise exception 'pot indexes missing: %', missing;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transfers'
      and column_name = 'pot_id'
  ) then
    raise exception 'transfers.pot_id was not created';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Documentation
-- ---------------------------------------------------------------------------

comment on table public.pots is
  'A named pot people contribute to. Exists before anyone is asked, which is why this is a table and split bill is not. Holds no balance: the running total is summed from transfers.pot_id at read time.';
comment on column public.pots.code is
  'Short shareable handle typed in chat ("pay pot k7m2q4"). Unique across all pots, case-insensitively. Not a secret and not a capability: knowing it lets you pay in, never take out.';
comment on column public.pots.name is
  'What the pot is for, as the organiser typed it. Renameable, which is one of the three reasons this is a table. Attacker-controlled text: render through displaySafeLabel.';
comment on column public.pots.target_eth is
  'Optional goal. Null means open-ended: a pot can collect without a finish line. Never a cap, because refusing money someone tried to give is worse than overshooting.';
comment on column public.pots.status is
  'open or closed. Closing stops new contributions; it does not move money, which already settled to the organiser as it arrived.';
comment on column public.pots.owner_account_id is
  'The organiser. Contributions settle straight to this account wallet, so this is also who holds the money.';
comment on column public.transfers.pot_id is
  'Set when this transfer was a contribution to a pot. The pot total is a sum over confirmed rows carrying this. Null for every ordinary send.';
