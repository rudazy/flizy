-- One-time approval links for chat.
--
-- Flizy no longer takes the PIN in a chat message: a message stays in the chat
-- history, on the phone and on the chat provider's servers. Instead, when chat
-- needs the PIN (to unlock, to approve a payment that needs it, to unlink), the
-- bot writes a row here and sends a link to https://flizy.app/a/<token>. The
-- PIN is typed on that page. The site marks the row approved; the bot that
-- wrote it picks the approval up and carries on.
--
--   token_hash   sha256 of the 128-bit token in the link. The token itself is
--                never stored.
--   kind         unlock | plan | unlink
--   summary      what the page shows: a title and lines the bot composed from
--                the plan it is holding. The page renders it as text only.
--   chat_label   which chat this is for ("WhatsApp ending 2222"), so a
--                forwarded link says whose chat it would act on.
--   expires_at   5 minutes after creation, the same as the plan it approves.
--   approved_at  set once, by the site, after the PIN (or passkey) is right.
--   consumed_at  set once, by the bot, when it acts on the approval.
--   cancelled_at set when the plan is replaced, or the page burns the link
--                after a PIN lockout.
--
-- Reachable by service_role only, like every table in public.
--
-- Idempotent: safe to run twice.

create table if not exists public.chat_approvals (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  account_id uuid not null references public.accounts (id) on delete cascade,
  channel text not null,
  external_id text not null,
  kind text not null,
  summary jsonb not null default '{}'::jsonb,
  chat_label text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  consumed_at timestamptz,
  cancelled_at timestamptz,
  constraint chat_approvals_kind_check check (kind in ('unlock', 'plan', 'unlink')),
  constraint chat_approvals_channel_check check (channel in ('whatsapp', 'telegram'))
);

create unique index if not exists chat_approvals_token_hash_unique
  on public.chat_approvals (token_hash);

create index if not exists chat_approvals_account_idx
  on public.chat_approvals (account_id, created_at desc);

comment on table public.chat_approvals is
  'One-time PIN approval links for chat (unlock, a payment, unlink). Approved on flizy.app/a/<token>, acted on by the bot that created the row.';

alter table public.chat_approvals enable row level security;
revoke all on table public.chat_approvals from public, anon, authenticated;
grant all on table public.chat_approvals to service_role;

do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'chat_approvals' and c.relrowsecurity
  ) then
    raise exception 'chat_approvals missing or RLS off after migration';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'chat_approvals_token_hash_unique'
  ) then
    raise exception 'chat_approvals_token_hash_unique missing after migration';
  end if;
end
$$;
