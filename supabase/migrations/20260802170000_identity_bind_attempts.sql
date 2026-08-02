-- Lockout store for the identity bind, and for the OAuth callback route.
--
-- Keyed on account_id, not on (channel, external_id) like link_code_attempts.
-- The difference is deliberate. A link code is a guessable secret, so counting
-- per identity is right. An OAuth callback is not: GitHub proves the id and the
-- caller cannot choose it, so counting per identity would throttle the identity's
-- legitimate owner. Counting per account throttles the account that keeps
-- triggering rejects, which is the only abuse shape left here.
--
-- Honest scope note: this ladder has little to bite on, because there is no API
-- that accepts a caller-supplied external_id, so an attacker cannot enumerate.
-- It is depth, not the primary defence. The primary defences are the OAuth proof
-- itself and the per-route limit on the callback, which is DB-backed here rather
-- than in memory because the web app runs serverless and a per-instance Map
-- would reset constantly and enforce nothing.
--
-- Column shape mirrors link_code_attempts so the pure lockoutLadder math
-- (FREE_ATTEMPTS, lockoutMsForAttempts, formatWait, lockStateFrom) drops
-- straight in with no second implementation.
--
-- Idempotent: safe to run twice.

create table if not exists public.identity_bind_attempts (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists identity_bind_attempts_locked_idx
  on public.identity_bind_attempts (locked_until)
  where locked_until is not null;

alter table public.identity_bind_attempts enable row level security;

comment on table public.identity_bind_attempts is
  'Escalating lockout for identity binds, keyed per account. Counts LINK_REJECTED_ALREADY_TAKEN and LINK_REJECTED_ALREADY_LINKED. Cleared by a successful bind. Same ladder math as link_code_attempts and the PIN lockout.';
comment on column public.identity_bind_attempts.failed_attempts is
  'Consecutive rejected binds. Reset to 0 by a bind that succeeds.';

-- ---------------------------------------------------------------------------
-- Per-route limiter for the OAuth callback.
-- ---------------------------------------------------------------------------

-- Separate from the bind ladder above because it is keyed on the web session
-- rather than the account: a callback can be refused before any account is
-- resolved (bad state, failed exchange), and those attempts still need counting.
create table if not exists public.oauth_callback_attempts (
  session_key text primary key,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists oauth_callback_attempts_locked_idx
  on public.oauth_callback_attempts (locked_until)
  where locked_until is not null;

alter table public.oauth_callback_attempts enable row level security;

comment on table public.oauth_callback_attempts is
  'Per-route limiter for the OAuth callback, keyed on a hash of the web session token. DB-backed on purpose: the web app is serverless, so an in-memory counter would be per-instance and enforce nothing.';
comment on column public.oauth_callback_attempts.session_key is
  'sha256 of the session token, never the token itself. Matches how web_sessions stores its hash.';

-- ---------------------------------------------------------------------------
-- Post-condition
-- ---------------------------------------------------------------------------

do $$
declare
  missing text;
begin
  select string_agg(t.name, ', ')
  into missing
  from (values ('identity_bind_attempts'), ('oauth_callback_attempts')) as t(name)
  where to_regclass('public.' || t.name) is null;

  if missing is not null then
    raise exception 'bind attempt tables missing: %', missing;
  end if;
end
$$;
