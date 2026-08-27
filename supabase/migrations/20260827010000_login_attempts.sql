-- Password-guess counter for site login and password re-auth.
--
-- Chat PIN and link codes already climb lib/lockoutLadder.js. Login did not:
-- POST /api/auth/login ran scrypt and returned 401 with no per-email cap, so a
-- known mailbox could be brute-forced online. The same gap existed on
-- requirePassword (pay, PIN, trusted, limits) once a session cookie was stolen.
--
-- Keyed on sha256(lowercased email), not on account_id. A guess against an
-- address that is not registered must climb the same ladder as one that is,
-- otherwise 429 vs 401 is an oracle. The hash means this table is not a
-- directory of attempted mailboxes.
--
-- Same ladder as PIN/link: 4 free, then 1 min / 5 min / 15 min / 1 h / 24 h.
-- A correct password (full login, or a passing requirePassword) resets the row.
--
-- Additive only.

create table if not exists public.login_attempts (
  email_key text primary key,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists login_attempts_locked_idx
  on public.login_attempts (locked_until);

alter table public.login_attempts enable row level security;

revoke all on table public.login_attempts from anon, authenticated;
grant all on table public.login_attempts to service_role;

comment on table public.login_attempts is
  'Wrong password counter per sha256(email). Same lockout ladder as PIN and link codes.';

comment on column public.login_attempts.email_key is
  'sha256 of trimmed lowercase email. Never the raw address.';

comment on column public.login_attempts.failed_attempts is
  'Consecutive wrong passwords. Reset only by a password that is accepted.';

comment on column public.login_attempts.locked_until is
  'While in the future, login and password re-auth refuse before the hash is checked.';

do $$
begin
  if to_regclass('public.login_attempts') is null then
    raise exception 'login_attempts is missing';
  end if;
end
$$;
