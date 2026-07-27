-- Opaque server-side sessions for the site.
--
-- The cookie used to be the raw account id, unsigned. That made it a bearer
-- token the server could not revoke, and the same value is an input to the
-- agent wallet derivation, so it must not sit in a browser at all.
--
-- Now the cookie carries a random token and only the SHA-256 hash of that token
-- is stored here. A leaked database row cannot be replayed as a session, and
-- deleting rows for an account logs that account out everywhere.

create table if not exists public.web_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Lookup path on every authenticated request.
create index if not exists web_sessions_token_hash_idx
  on public.web_sessions (token_hash);

-- Revoke-all for one account (password reset, recovery, logout everywhere).
create index if not exists web_sessions_account_idx
  on public.web_sessions (account_id, created_at desc);

-- Cheap sweep of dead rows.
create index if not exists web_sessions_expires_idx
  on public.web_sessions (expires_at);

alter table public.web_sessions enable row level security;

comment on table public.web_sessions is
  'Site session tokens. Stores sha256(token) only, never the token. Cookie holds the raw token.';

comment on column public.web_sessions.token_hash is
  'sha256 hex of the session token from the cookie. Unique so a token maps to one session.';
