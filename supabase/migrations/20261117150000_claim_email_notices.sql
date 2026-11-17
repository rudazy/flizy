-- Claims: emailing a recipient who is not on Flizy.
--
--   claim_email_notices   one row per email sent about a claim, of each kind:
--                           first      right after the hold landed
--                           reminder   once, if still unclaimed after the delay
--                         unique per claim and kind, so a claim is emailed at
--                         most once and reminded at most once, however often a
--                         send is retried. The address is not stored: only a
--                         SHA-256 hash of it, to count the per-address limit.
--     state                 sending, then sent (the provider accepted it) or
--                           failed
--   email_suppressions    addresses that asked for no more of these emails,
--                         as a SHA-256 hash of the normalised address, never
--                         the address. Payments to it still work; only the
--                         emails stop.
--
-- Service role only. Idempotent. A partial apply fails the post-condition.

create table if not exists public.claim_email_notices (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  kind text not null,
  sender_account_id uuid references public.accounts (id) on delete set null,
  recipient_hash text not null,
  state text not null default 'sending',
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint claim_email_notices_kind_check check (kind in ('first', 'reminder')),
  constraint claim_email_notices_state_check check (state in ('sending', 'sent', 'failed')),
  constraint claim_email_notices_hash_check check (recipient_hash ~ '^[0-9a-f]{64}$'),
  constraint claim_email_notices_once unique (claim_id, kind)
);

create index if not exists claim_email_notices_sender_idx on public.claim_email_notices (sender_account_id, created_at desc);
create index if not exists claim_email_notices_recipient_idx on public.claim_email_notices (recipient_hash, created_at desc);

comment on table public.claim_email_notices is
  'Emails sent to claim recipients not on Flizy: at most one first and one reminder per claim. The address is kept only as a hash.';

create table if not exists public.email_suppressions (
  email_hash text primary key,
  created_at timestamptz not null default now(),
  constraint email_suppressions_hash_check check (email_hash ~ '^[0-9a-f]{64}$')
);

comment on table public.email_suppressions is
  'Addresses that stopped claim notification emails, as SHA-256 hashes. Payments to them still work.';

alter table public.claim_email_notices enable row level security;
alter table public.email_suppressions enable row level security;
revoke all on table public.claim_email_notices from public, anon, authenticated;
revoke all on table public.email_suppressions from public, anon, authenticated;
grant all on table public.claim_email_notices to service_role;
grant all on table public.email_suppressions to service_role;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'claim_email_notices_once') then
    raise exception 'claim_email_notices_once is missing';
  end if;
  if not exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'email_suppressions'
  ) then
    raise exception 'email_suppressions is missing';
  end if;
  if (select relrowsecurity from pg_class where oid = 'public.claim_email_notices'::regclass) is not true
    or (select relrowsecurity from pg_class where oid = 'public.email_suppressions'::regclass) is not true then
    raise exception 'claim email tables have no row level security';
  end if;
end
$$;
