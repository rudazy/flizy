-- Retire outbox rows queued for channels nothing drains.
--
-- `notifications` is drained per channel by whichever process owns that channel:
-- index.js registers a WhatsApp sender and drains it, lib/telegram/bot.js does
-- the same for Telegram. Nothing registers a sender for x, github or discord.
--
-- An account may still link those, and a fan-out that writes one row per
-- linked identity leaves rows on those channels that are never going to be
-- read. They sit pending indefinitely while the code that queued them reports
-- success.
--
-- Two consequences worth separating. The rows themselves are only noise: they
-- make `status = 'pending'` useless as a health signal and they grow without
-- bound. The real cost is upstream, in a caller believing it had warned
-- somebody. That half is handled in lib/notify.js and web/lib/notifyChannels.ts,
-- which skip a channel unless something drains it; this file only clears rows
-- already written to those channels.
--
-- Marked `failed` with a reason rather than deleted. A notification is a record
-- that the product tried to tell somebody something, and the fact that it could
-- not is exactly what a later reader needs to know. Deleting would leave the
-- question of why the outbox is short.
--
-- Idempotent: safe to run twice. The second run matches nothing, because the
-- first left no pending rows on those channels.

update public.notifications
set status = 'failed',
    error = coalesce(nullif(error, ''), 'no process drains this channel')
where status = 'pending'
  and channel in ('x', 'github', 'discord');

-- ---------------------------------------------------------------------------
-- Post-condition. An invariant, not a fact about this moment: no matter when
-- this runs or how often, nothing may be left waiting on a channel that has no
-- reader. A future channel gaining a sender is a code change plus an entry in
-- DELIVERABLE_CHANNELS, and this assertion is what makes the omission loud.
-- ---------------------------------------------------------------------------

do $$
declare
  stranded integer;
begin
  select count(*) into stranded
  from public.notifications
  where status = 'pending'
    and channel in ('x', 'github', 'discord');

  if stranded > 0 then
    raise exception
      '% notification(s) still pending on a channel nothing drains', stranded;
  end if;
end
$$;
