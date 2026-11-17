-- Claims: what happened to each one, for its sender.
--
-- One row per thing that happened to a claim, never edited (append-only):
--
--   created            the hold landed and the claim was written
--   notified           the recipient was told (channel: how)
--   link_shared        the sender shared the claim link (channel: where)
--   link_opened        the claim link was first opened by someone other than
--                      the sender; at most once per claim
--   recipient_pinned   a Telegram @username claim was tied to the numeric id
--                      of the user who opened it in the bot
--   claimed            paid out to the recipient
--   cancelled          the sender cancelled it
--   expired            it passed its expiry (Flizy Pay API claims only)
--   refunded           the money went back to the sender
--
-- channel is how or where (chat, email, telegram, whatsapp, discord, github,
-- x, share_link), or null. meta holds short codes only, never a phone, an
-- email, a name or an address. Claims from before this table have no rows and
-- keep the status the claims table gives them.
--
-- Service role only. Idempotent. A partial apply fails the post-condition.

create table if not exists public.claim_events (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  event text not null,
  channel text,
  meta jsonb,
  created_at timestamptz not null default now(),
  constraint claim_events_event_check check (
    event in ('created', 'notified', 'link_shared', 'link_opened', 'recipient_pinned', 'claimed', 'cancelled', 'expired', 'refunded')
  ),
  constraint claim_events_channel_check check (
    channel is null or channel in ('chat', 'email', 'telegram', 'whatsapp', 'discord', 'github', 'x', 'share_link')
  ),
  constraint claim_events_meta_check check (meta is null or (jsonb_typeof(meta) = 'object' and pg_column_size(meta) <= 512))
);

create index if not exists claim_events_claim_idx on public.claim_events (claim_id, created_at);

-- The first open only: a second insert for the same claim is refused.
create unique index if not exists claim_events_link_opened_once
  on public.claim_events (claim_id)
  where event = 'link_opened';

comment on table public.claim_events is
  'What happened to each claim, for its sender. Append-only; no personal data in meta.';

alter table public.claim_events enable row level security;
revoke all on table public.claim_events from public, anon, authenticated;
grant all on table public.claim_events to service_role;

do $$
begin
  if not exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'claim_events'
  ) then
    raise exception 'claim_events is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'claim_events_event_check') then
    raise exception 'claim_events_event_check is missing';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'claim_events_link_opened_once') then
    raise exception 'claim_events_link_opened_once is missing';
  end if;
  if (select relrowsecurity from pg_class where oid = 'public.claim_events'::regclass) is not true then
    raise exception 'claim_events has no row level security';
  end if;
end
$$;
