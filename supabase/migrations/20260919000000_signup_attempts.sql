-- Per-IP cap on account creation.
--
-- POST /api/auth/signup had no cap of any kind. Every request created an
-- accounts row AND sent a verification code to whatever address was posted, so
-- the route was an open email relay against arbitrary mailboxes and an
-- unbounded source of rows. The limits in web/lib/emailVerify.ts do not help:
-- they are keyed on account_id, and a fresh signup mints a new one each time.
--
-- Keyed on sha256 of the client IP, so the column is not a plaintext list of
-- addresses. That is all it is: IPv4 is 2^32 values and a plain digest over it
-- is reversible cheaply, so this is a counter key, not anonymisation, and it
-- should not be cited as one. Unlike login_attempts this is NOT the ladder:
-- the abuse here is volume, not guessing, and a successful signup has to count
-- the same as a refused one. A fixed window is the right shape for that.
--
-- Additive only.

create table if not exists public.signup_attempts (
  ip_key text primary key,
  attempts integer not null default 0,
  window_started_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Serves the sampled cleanup inside bump_signup_attempts, which would otherwise
-- seq-scan the whole table.
create index if not exists signup_attempts_last_attempt_idx
  on public.signup_attempts (last_attempt_at);

alter table public.signup_attempts enable row level security;

revoke all on table public.signup_attempts from anon, authenticated;
grant all on table public.signup_attempts to service_role;

comment on table public.signup_attempts is
  'Fixed-window signup counter per sha256(client IP). Volume cap, not a lockout ladder.';

comment on column public.signup_attempts.ip_key is
  'sha256 of the client IP. Never the raw address.';

comment on column public.signup_attempts.attempts is
  'Signups started in the current window. Counts refused attempts too, so hammering cannot reset it.';

comment on column public.signup_attempts.window_started_at is
  'Start of the current fixed window. Rolls forward only when an attempt arrives after it expired.';

-- Read, decide and write in one statement.
--
-- Doing this as select-then-upsert from the route would let two concurrent
-- requests both read attempts = max - 1 and both be admitted. The insert ..
-- on conflict do update takes a row lock, so the count is exact under
-- concurrency. Same reasoning as try_account_tx_lock in
-- 20260827000000_account_tx_locks.sql.
--
-- Out params are named so none collides with a column of the table, because
-- plpgsql substitutes its variables into the SQL body and a name clash here
-- would silently rewrite the wrong side of the assignment.
create or replace function public.bump_signup_attempts(
  p_ip_key text,
  p_window_ms bigint,
  p_max integer
)
returns table (allowed boolean, used integer, retry_after_ms bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Cast spelled out: p_window_ms / 1000.0 is numeric, make_interval wants
  -- double precision, and leaning on an implicit cast here is the kind of thing
  -- that works until the day it is called with a different numeric type.
  v_window interval := make_interval(secs => (p_window_ms / 1000.0)::double precision);
  v_attempts integer;
  v_started timestamptz;
begin
  insert into public.signup_attempts as s (ip_key, attempts, window_started_at, last_attempt_at)
  values (p_ip_key, 1, now(), now())
  on conflict (ip_key) do update
    set attempts = case
          when s.window_started_at < now() - v_window then 1
          else s.attempts + 1
        end,
        window_started_at = case
          when s.window_started_at < now() - v_window then now()
          else s.window_started_at
        end,
        last_attempt_at = now()
  returning s.attempts, s.window_started_at into v_attempts, v_started;

  -- Sampled so the delete does not ride on every signup. Rows are tiny, but an
  -- attacker rotating source addresses would otherwise grow this table without
  -- any bound at all.
  if random() < 0.01 then
    delete from public.signup_attempts
    where last_attempt_at < now() - interval '24 hours';
  end if;

  allowed := v_attempts <= p_max;
  used := v_attempts;
  retry_after_ms := case
    when v_attempts <= p_max then 0
    else greatest(1000, (extract(epoch from (v_started + v_window - now())) * 1000)::bigint)
  end;
  return next;
end;
$$;

revoke all on function public.bump_signup_attempts(text, bigint, integer) from public, anon, authenticated;
grant execute on function public.bump_signup_attempts(text, bigint, integer) to service_role;

comment on function public.bump_signup_attempts(text, bigint, integer) is
  'Atomically count one signup attempt for an IP key and say whether it is allowed.';

do $$
begin
  if to_regclass('public.signup_attempts') is null then
    raise exception 'signup_attempts is missing';
  end if;
  if to_regproc('public.bump_signup_attempts') is null then
    raise exception 'bump_signup_attempts is missing';
  end if;
end
$$;
