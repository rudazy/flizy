-- Claims: record a refused claim attempt, and an email the rules did not send.
--
--   claim_events.event          adds claim_refused: someone tried to claim and
--                               was turned away (not signed in as the
--                               recipient, already claimed, cancelled, ...).
--                               meta holds a short reason code only, never who
--                               tried.
--   claim_email_notices.state   adds skipped: the site decided not to send this
--                               email (a limit, a stop request, the address is
--                               on Flizy, under the minimum). A skipped first
--                               email is final, so the catch-up that sends a
--                               first email the bot never asked for does not
--                               retry it. Skipped rows do not count toward the
--                               limits.
--
-- A changed rule gets a new name (test/schemaChecks.test.js), so each widened
-- check replaces the old one as <name>_v2. Nothing else changes. Idempotent. A
-- partial apply fails the post-condition.

alter table public.claim_events drop constraint if exists claim_events_event_check;
alter table public.claim_events drop constraint if exists claim_events_event_check_v2;
alter table public.claim_events add constraint claim_events_event_check_v2 check (
  event in ('created', 'notified', 'link_shared', 'link_opened', 'recipient_pinned', 'claimed', 'claim_refused', 'cancelled', 'expired', 'refunded')
);

alter table public.claim_email_notices drop constraint if exists claim_email_notices_state_check;
alter table public.claim_email_notices drop constraint if exists claim_email_notices_state_check_v2;
alter table public.claim_email_notices add constraint claim_email_notices_state_check_v2 check (state in ('sending', 'sent', 'failed', 'skipped'));

do $$
begin
  if exists (select 1 from pg_constraint where conname in ('claim_events_event_check', 'claim_email_notices_state_check')) then
    raise exception 'an old claim check is still in place';
  end if;
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'claim_events_event_check_v2')) not like '%claim_refused%' then
    raise exception 'claim_events_event_check_v2 does not allow claim_refused';
  end if;
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'claim_email_notices_state_check_v2')) not like '%skipped%' then
    raise exception 'claim_email_notices_state_check_v2 does not allow skipped';
  end if;
end
$$;
