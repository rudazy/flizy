-- Trusted destinations: a hold on new ones, and a carrier for adds started in chat.
--
-- Adding a payout destination creates the ability to move money repeatedly,
-- without the owner present. Spending money once is the lesser act. Until now
-- the two were gated the same, and on the chat surface the destination add was
-- gated less: `add wallet 0x...` reached the table with no password and no PIN.
--
-- Two changes here.
--
-- 1. Every new destination starts under a 24 hour hold, as does any change of
--    an existing destination's address and any re-add of one that was
--    cancelled. The owner is notified and can cancel inside the window. Rows
--    that exist today are backfilled as already past their hold, because they
--    are already live and must stay live.
--
-- 2. A ticket table, so an add begun in chat can be finished on the site
--    without the person retyping an address they may never have seen (the
--    post-payment "save this merchant" case). The ticket carries the address.
--    It is NOT a credential: completing the add still requires the account
--    password on the site, so a stolen ticket grants nothing.
--
-- Usability is one predicate, used everywhere:
--     status = 'active' and active_at <= now()
--
-- `status` records the owner's decision (active, or cancelled). `active_at`
-- records when the hold ends. "Pending" is the state a user sees and is derived,
-- not stored: status = 'active' and active_at > now(). Nothing has to flip a
-- row from held to usable, so no scheduled job exists to fail.
--
-- Additive only.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.trusted_addresses
  add column if not exists status text,
  add column if not exists active_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Backfill BEFORE the trigger exists
--
-- Order matters. The trigger below forces every touched row into a fresh hold,
-- so this has to complete first or it would put live users into 24 hours of
-- refused sends. active_at is set to created_at, which is in the past, so these
-- rows are usable the moment the predicate is applied.
-- ---------------------------------------------------------------------------

update public.trusted_addresses
set status = 'active',
    active_at = coalesce(active_at, created_at, now() - interval '1 day')
where status is null;

alter table public.trusted_addresses
  alter column status set default 'active',
  alter column status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'trusted_addresses_status_check'
  ) then
    alter table public.trusted_addresses
      add constraint trusted_addresses_status_check
      check (status in ('active', 'cancelled'));
  end if;
end
$$;

-- Serves the usability predicate on the send path, which runs on every transfer.
create index if not exists trusted_addresses_usable_idx
  on public.trusted_addresses (account_id, status, active_at);

comment on column public.trusted_addresses.status is
  'Owner decision: active, or cancelled. Never deleted on cancel, so the attempt stays on record.';

comment on column public.trusted_addresses.active_at is
  'When the 24 hour hold ends. Usable only when status = active and active_at <= now().';

-- ---------------------------------------------------------------------------
-- 3. The hold, applied by the database
--
-- Deliberately a trigger and not application code. There are three writers
-- today (the bot module, the web module, and the pay-save route) and the audit
-- that prompted this work found a fourth that everyone had forgotten. A writer
-- added next year cannot opt out of this.
--
-- Changing the address of an existing row is the same act as adding a new
-- destination and gets the same hold. Changing only the label does not, because
-- a label carries no authority.
-- ---------------------------------------------------------------------------

create or replace function public.trusted_addresses_apply_hold()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'active';
    new.active_at := now() + interval '24 hours';
    return new;
  end if;

  if new.address is distinct from old.address then
    new.status := 'active';
    new.active_at := now() + interval '24 hours';
    return new;
  end if;

  -- Re-adding a destination that was cancelled. The row still exists, so the
  -- add arrives as an update rather than an insert, and without this it would
  -- keep the cancelled row's dead state while reporting success. It is the same
  -- act as adding it for the first time, so it earns the same fresh hold.
  if old.status = 'cancelled' and new.status = 'active' then
    new.active_at := now() + interval '24 hours';
    return new;
  end if;

  -- Label edits and the cancel transition pass through untouched.
  return new;
end
$$;

drop trigger if exists trusted_addresses_hold on public.trusted_addresses;
create trigger trusted_addresses_hold
  before insert or update on public.trusted_addresses
  for each row
  execute function public.trusted_addresses_apply_hold();

comment on function public.trusted_addresses_apply_hold() is
  'Forces a 24 hour hold on a new destination, a change of address, or the re-add of a cancelled one. Label-only edits are untouched.';

-- ---------------------------------------------------------------------------
-- 4. Tickets: an add begun in chat, finished on the site
--
-- Short lived and single use, the same shape as link_codes. Bound to the
-- account that minted it, so a stolen code cannot prefill anyone else's form.
-- The password is still required to complete the add; this only carries the
-- address so the person does not have to retype one they never saw.
-- ---------------------------------------------------------------------------

create table if not exists public.trusted_add_tickets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  address text not null,
  label text not null default '',
  code text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint trusted_add_tickets_code_unique unique (code),
  constraint trusted_add_tickets_code_format check (code ~ '^[A-Z0-9]{6,12}$'),
  constraint trusted_add_tickets_addr_format check (address ~ '^0x[a-fA-F0-9]{40}$')
);

create index if not exists trusted_add_tickets_account_idx
  on public.trusted_add_tickets (account_id);
create index if not exists trusted_add_tickets_expires_idx
  on public.trusted_add_tickets (expires_at);

alter table public.trusted_add_tickets enable row level security;
revoke all on table public.trusted_add_tickets from anon, authenticated;
grant all on table public.trusted_add_tickets to service_role;

comment on table public.trusted_add_tickets is
  'Carries an address from a chat-started add to the site. Not a credential: the password is still required to complete.';

comment on column public.trusted_add_tickets.used_at is
  'Set when redeemed. Single use, so a code cannot be replayed after the add completes.';

-- ---------------------------------------------------------------------------
-- 5. Post-conditions. A partial apply must fail loudly.
-- ---------------------------------------------------------------------------

do $$
declare
  held integer;
begin
  if to_regclass('public.trusted_add_tickets') is null then
    raise exception 'trusted_add_tickets is missing';
  end if;

  if to_regproc('public.trusted_addresses_apply_hold') is null then
    raise exception 'trusted_addresses_apply_hold is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'trusted_addresses_hold' and not tgisinternal
  ) then
    raise exception 'trusted_addresses_hold trigger is missing';
  end if;

  if exists (
    select 1 from public.trusted_addresses where status is null or active_at is null
  ) then
    raise exception 'trusted_addresses has rows with no status or no active_at';
  end if;

  -- No destination may be held for longer than the hold itself.
  --
  -- This is deliberately an invariant rather than a check on the backfill. The
  -- first version asserted that nothing at all was held, which was true the
  -- moment this file was first applied and false forever after: re-applying it
  -- to fix the trigger body would trip over the first legitimately held row and
  -- refuse to run. An assertion that is only true once is a trap for whoever
  -- re-applies.
  --
  -- The hazard the old check aimed at is already covered above: a backfill that
  -- did not run leaves status or active_at null. What is left to catch is a
  -- wrong interval, from a bad backfill or a future edit to the trigger, and
  -- that shows up as a hold stretching past 24 hours. Slack for clock skew
  -- between the session and the server.
  select count(*) into held
  from public.trusted_addresses
  where active_at > now() + interval '24 hours 5 minutes';

  if held > 0 then
    raise exception
      '% destination(s) held longer than 24 hours; the hold interval is wrong', held;
  end if;
end
$$;
