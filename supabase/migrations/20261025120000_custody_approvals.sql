-- Passkey approval for one chat payment over a secured account's daily cap.
--
-- When a chat payment from an account with signed daily permissions is bigger
-- than what is left today, it is not sent on Flizy's owner key. It waits here
-- for the account's passkey (flizy.app/approve/{token}). The passkey signs a
-- permission for exactly that payment: this recipient, this amount, once,
-- before expires_at. The relayer on the bot host then sends it
-- (lib/custody/approvals.js).
--
-- The link token is never stored: only its sha256. The page shows what is
-- stored here, never what is in the URL. A row moves only forward:
--   pending -> signed -> sending -> submitted | sent | failed
--   pending | signed -> cancelled | expired
--
-- Nothing here is secret: a public permission whose bounds the chain enforces.
-- Service role only, like every table in public.
--
-- Idempotent: safe to run twice.

create table if not exists public.custody_approvals (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  token_hash text not null,
  transfer_id uuid references public.transfers (id) on delete set null,
  symbol text not null,
  gator text not null,
  delegate text not null,
  to_address text not null,
  recipient_label text,
  amount text not null,
  amount_display text not null,
  status text not null default 'pending',
  salt text,
  signed_at timestamptz,
  caveats jsonb,
  digest text,
  signature text,
  tx_hash text,
  error text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint custody_approvals_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint custody_approvals_symbol_check check (symbol in ('ETH', 'FLZ', 'TUSD')),
  constraint custody_approvals_address_check check (
    gator ~ '^0x[0-9a-fA-F]{40}$' and delegate ~ '^0x[0-9a-fA-F]{40}$' and to_address ~ '^0x[0-9a-fA-F]{40}$'
  ),
  constraint custody_approvals_amount_check check (amount ~ '^[1-9][0-9]{0,77}$'),
  constraint custody_approvals_status_check check (
    status in ('pending', 'signed', 'sending', 'submitted', 'sent', 'failed', 'cancelled', 'expired')
  ),
  constraint custody_approvals_digest_check check (digest is null or digest ~ '^0x[0-9a-f]{64}$'),
  constraint custody_approvals_signed_check check (status in ('pending', 'cancelled', 'expired') or signature ~ '^0x[0-9a-f]+$'),
  constraint custody_approvals_tx_check check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$')
);

create unique index if not exists custody_approvals_token_once
  on public.custody_approvals (token_hash);

-- The worker's two queries: signed rows to send, open rows to expire.
create index if not exists custody_approvals_open
  on public.custody_approvals (status, expires_at)
  where status in ('pending', 'signed');

create index if not exists custody_approvals_account
  on public.custody_approvals (account_id, created_at desc);

alter table public.custody_approvals enable row level security;
revoke all on table public.custody_approvals from anon, authenticated;
grant all on table public.custody_approvals to service_role;

comment on table public.custody_approvals is
  'Chat payments over a secured account''s daily cap, waiting for or approved by its passkey as a one-time permission. Link token stored as sha256 only. Service role only.';

-- ---------------------------------------------------------------------------
-- Post-condition: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.custody_approvals') is null then
    raise exception 'public.custody_approvals is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.custody_approvals'::regclass) then
    raise exception 'row level security is off on public.custody_approvals';
  end if;
  if has_table_privilege('anon', 'public.custody_approvals', 'select')
     or has_table_privilege('authenticated', 'public.custody_approvals', 'select') then
    raise exception 'public.custody_approvals is readable outside the service role';
  end if;
  if to_regclass('public.custody_approvals_token_once') is null then
    raise exception 'custody_approvals_token_once is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'custody_approvals_signed_check') then
    raise exception 'custody_approvals_signed_check is missing';
  end if;
end
$$;
