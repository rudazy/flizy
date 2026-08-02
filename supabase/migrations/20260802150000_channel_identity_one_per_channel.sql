-- One platform identity per account per channel.
--
-- Deliberately PARTIAL, covering only the platform channels.
--
-- An unqualified unique on (account_id, channel) would also bind whatsapp and
-- telegram, and that breaks a live recovery path: when someone's WhatsApp LID
-- changes (new device, or the LID migration), they redeem a link code and
-- consumeLinkCode inserts a second whatsapp row for the same account. Nothing
-- violates an unqualified unique today, but it would forbid a state the product
-- currently depends on. Chat channels keep today's behaviour.
--
-- The index name is load-bearing. A 23505 raised here has to be told apart from
-- one raised by channel_identities_channel_external_idx: this one means "this
-- account already has a different identity on this channel" (ALREADY_LINKED_
-- DIFFERENT), the other means a concurrent bind won the race and the caller
-- should re-resolve. lib/channelBind.js matches on this exact name.
--
-- SAFETY: checked against live data before writing. Zero accounts hold two
-- identities on one channel (whatsapp 2, telegram 1, spread across accounts),
-- so this validates with no backfill. The pre-flight below re-checks at apply
-- time rather than trusting that snapshot.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Pre-flight: refuse to run against data that would violate the index
-- ---------------------------------------------------------------------------

do $$
declare
  offenders text;
begin
  select string_agg(format('account=%s channel=%s n=%s', account_id, channel, n), '; ')
  into offenders
  from (
    select account_id, channel, count(*) as n
    from public.channel_identities
    where channel in ('x', 'github', 'discord')
    group by account_id, channel
    having count(*) > 1
  ) bad;

  if offenders is not null then
    raise exception 'cannot add one-per-channel index, existing violations: %', offenders;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The index
-- ---------------------------------------------------------------------------

create unique index if not exists channel_identities_account_platform_idx
  on public.channel_identities (account_id, channel)
  where channel in ('x', 'github', 'discord');

comment on index public.channel_identities_account_platform_idx is
  'One platform identity per account per channel. Partial on purpose: whatsapp and telegram may hold more than one identity per account, which is how a changed WhatsApp LID is re-linked. Name is matched by lib/channelBind.js to map a 23505 to ALREADY_LINKED_DIFFERENT.';

-- ---------------------------------------------------------------------------
-- 3. Post-condition
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'channel_identities_account_platform_idx'
  ) then
    raise exception 'channel_identities_account_platform_idx was not created';
  end if;
end
$$;
