-- RLS-caller probe for the accounts_username_not_reserved trigger.
-- NOT a migration. Run by hand in the SQL editor AFTER
-- 20260811000000_reserved_usernames.sql has been applied.
--
-- Why this exists: the five-column check query reads everything as postgres,
-- which bypasses RLS, so it returns an identical pass row whether or not the
-- trigger function is security definer. Nothing in that query proves the
-- trigger fires for a caller that IS subject to RLS, which is the entire
-- reason security definer was added. This probe closes that gap.
--
-- Safety: writes nothing. It ends by raising, so the surrounding transaction
-- always aborts and both probe inserts are discarded. The raised message IS
-- the result. Read it; do not read it as a failure.
--
-- How to read the verdict:
--   secdef=t          security definer is set on the trigger function
--   visible_to_auth=0 RLS really is hiding reserved_usernames from authenticated,
--                     so the probe is exercising the real condition and not a
--                     table that happens to be readable
--   reserved=FZ002    the trigger fired for an RLS-subject caller  <-- the point
--   control=42501     a NON-reserved insert was stopped downstream by accounts
--                     RLS rather than by the trigger, which is what makes the
--                     FZ002 above attributable to the trigger and not ambient
--
-- reserved=42501 is the failure signal: the trigger no-opped (the lookup saw
-- zero rows) and accounts RLS caught the row afterwards. That is precisely the
-- inverted behaviour security definer fixes.

do $$
declare
  secdef      boolean;
  can_insert  boolean;
  visible     bigint;
  reserved    text;
  control     text;
  verdict     text;
begin
  select p.prosecdef into secdef
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'accounts_enforce_username_not_reserved';

  if secdef is null then
    raise exception 'PROBE ABORTED: accounts_enforce_username_not_reserved does not exist. Apply the migration first.';
  end if;

  -- If authenticated lacks the INSERT grant outright, the privilege check fires
  -- before any trigger and every result below would be a false negative.
  can_insert := has_table_privilege('authenticated', 'public.accounts', 'INSERT');

  set local role authenticated;

  select count(*) into visible from public.reserved_usernames;

  -- Case under test: a seeded reserved key.
  begin
    insert into public.accounts (username) values ('admin');
    reserved := 'NO ERROR (trigger did not fire and nothing else stopped it)';
  exception when others then
    reserved := sqlstate;
  end;

  -- Control: not a reserved key, so the trigger must NOT be what stops it.
  begin
    insert into public.accounts (username) values ('probe0not0reserved0name');
    control := 'NO ERROR';
  exception when others then
    control := sqlstate;
  end;

  reset role;

  verdict := case
    when not can_insert then
      'INCONCLUSIVE - authenticated has no INSERT grant on public.accounts, so the '
      || 'privilege check fires before the trigger. Results below prove nothing.'
    when reserved = 'FZ002' and control = '42501' and secdef then
      'PASS - trigger fired for an RLS-subject caller, control was stopped downstream.'
    when reserved = 'FZ002' and control = 'FZ002' then
      'SUSPECT - control also raised FZ002. The trigger is matching a name it should '
      || 'not; check username_reserved_key collapse behaviour.'
    when reserved = '42501' then
      'FAIL - trigger did not fire. The lookup saw zero rows under RLS and accounts '
      || 'RLS caught the row afterwards. This is the inverted behaviour; confirm '
      || 'security definer is set.'
    when reserved like 'NO ERROR%' then
      'FAIL - reserved username was accepted outright. Trigger inert AND accounts is '
      || 'writable by authenticated. Treat as urgent.'
    else
      'UNEXPECTED - read the raw values below.'
  end;

  raise exception E'RESERVED-USERNAME RLS PROBE (nothing committed)\n%\n  secdef=%\n  auth_has_insert=%\n  visible_to_auth=%\n  reserved=%\n  control=%',
    verdict, secdef, can_insert, visible, reserved, control;
end
$$;
