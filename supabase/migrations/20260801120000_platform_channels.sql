-- Allow platform channels (x, github, discord) alongside the chat channels.
--
-- Identity is already channel-agnostic: (channel, external_id) -> account. What
-- is not yet agnostic is the list of channels the database will accept, which is
-- pinned by a CHECK constraint in three places:
--
--   channel_identities.channel  (channel_identities_channel_check)
--   sessions.channel            (sessions_channel_check)
--   notifications.channel       (created inline, so auto-named)
--
-- This widens all three. It does not add columns, touch claims, or create any
-- identity: nothing writes these channels yet. It only stops the database from
-- rejecting them once something does.
--
-- SAFETY: widening is the strictly weaker predicate, so no existing row can be
-- invalidated by it. Verified against the live tables before writing this:
-- channel_identities held only whatsapp and telegram, sessions only whatsapp,
-- notifications was empty. The re-add still revalidates every row, which is why
-- the drop and add are paired rather than the constraint being left in place.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Drop the narrow checks
-- ---------------------------------------------------------------------------

-- Found by definition rather than by name. Two of the three were named
-- explicitly, but the notifications one was written inline in the create table,
-- so it carries a name Postgres generated. Matching on the definition drops the
-- right constraint in every case, including a re-run of this migration.
do $$
declare
  con record;
begin
  for con in
    select rel.relname as table_name, c.conname as constraint_name
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname in ('channel_identities', 'sessions', 'notifications')
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%whatsapp%'
  loop
    execute format(
      'alter table public.%I drop constraint %I',
      con.table_name,
      con.constraint_name
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Re-add them wide, all three named the same way
-- ---------------------------------------------------------------------------

alter table public.channel_identities
  add constraint channel_identities_channel_check
  check (channel in ('whatsapp', 'telegram', 'x', 'github', 'discord'));

alter table public.sessions
  add constraint sessions_channel_check
  check (channel in ('whatsapp', 'telegram', 'x', 'github', 'discord'));

alter table public.notifications
  add constraint notifications_channel_check
  check (channel in ('whatsapp', 'telegram', 'x', 'github', 'discord'));

-- ---------------------------------------------------------------------------
-- 3. Post-condition: prove no narrow check survived
-- ---------------------------------------------------------------------------

-- A leftover narrow constraint would not error here on its own, it would sit
-- alongside the wide one and quietly reject every platform channel, because a
-- row must satisfy every check on the table. So this fails the migration rather
-- than letting that ship.
do $$
declare
  survivors text;
  missing text;
begin
  select string_agg(format('%s.%s', rel.relname, c.conname), ', ')
  into survivors
  from pg_constraint c
  join pg_class rel on rel.oid = c.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname in ('channel_identities', 'sessions', 'notifications')
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%whatsapp%'
    and pg_get_constraintdef(c.oid) not like '%github%';

  if survivors is not null then
    raise exception 'a narrow channel check survived: %', survivors;
  end if;

  select string_agg(t.name, ', ')
  into missing
  from (values ('channel_identities'), ('sessions'), ('notifications')) as t(name)
  where not exists (
    select 1
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = t.name
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%github%'
  );

  if missing is not null then
    raise exception 'channel check not widened on: %', missing;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Documentation
-- ---------------------------------------------------------------------------

comment on table public.channel_identities is
  'Chat and platform identities bound to accounts. One row per (channel, external_id). WhatsApp external_id is the observed sender id (often a LID); Telegram external_id is the numeric user id; x, github and discord external_id is that platform''s immutable numeric user id, never the handle, because handles are renamed and reassigned.';

comment on column public.notifications.channel is
  'Channel the message is addressed to. A channel with no registered sender process queues here until one drains it.';
