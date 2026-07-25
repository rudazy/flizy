-- Cross-channel notification outbox.
--
-- The WhatsApp client needs a live whatsapp-web.js session to deliver a message,
-- so a process that does not hold that session (the Telegram client) queues here
-- and the owning process drains its own channel. Telegram delivery is a plain
-- HTTPS call, so it is usually sent inline and never touches this table.
--
-- Bodies are user-facing bot copy only. Never queue secrets.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts (id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'telegram')),
  external_id text not null,
  body text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists notifications_pending_idx
  on public.notifications (channel, status, created_at)
  where status = 'pending';

create index if not exists notifications_account_idx
  on public.notifications (account_id, created_at desc);

alter table public.notifications enable row level security;

comment on table public.notifications is
  'Outbound bot messages queued for a client process that owns the channel session. Drained by that process.';
