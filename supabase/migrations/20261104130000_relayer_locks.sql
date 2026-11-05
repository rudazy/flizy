-- One relayer transaction in flight at a time, per relayer key.
--
-- A relayer (CUSTODY_RELAYER_KEY today) takes its nonce from the node's
-- pending count. Two sends that pick the nonce at the same moment get the same
-- one, and the node refuses the second. Chat sends and the approvals worker
-- share the key, and they run in more than one bot process, so an in-memory
-- lock is not enough. lib/custody/relayerLock.js holds this lease from the
-- nonce pick until the node has accepted the transaction, then releases it;
-- waiting for the receipt happens outside it.
--
-- The lease is keyed by the relayer's address, so a second relayer key gets its
-- own lock. It expires on its own, so a process that dies holding it frees it.
-- Each holder passes its own token; release only takes effect for that holder.
--
-- Service role only. Idempotent. A partial apply fails the post-condition.

create table if not exists public.relayer_locks (
  relayer text primary key,
  holder text not null,
  expires_at timestamptz not null,
  constraint relayer_locks_relayer_check check (relayer ~ '^0x[0-9a-f]{40}$'),
  constraint relayer_locks_holder_check check (char_length(holder) between 16 and 64)
);

alter table public.relayer_locks enable row level security;

-- Take the lease when it is free or has expired, in one statement.
create or replace function public.try_relayer_lock(
  p_relayer text,
  p_holder text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  taken text;
begin
  if p_relayer is null or p_holder is null or p_ttl_seconds is null
     or p_ttl_seconds < 1 or p_ttl_seconds > 300 then
    return false;
  end if;
  insert into public.relayer_locks (relayer, holder, expires_at)
  values (lower(p_relayer), p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (relayer) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where public.relayer_locks.expires_at < now()
  returning holder into taken;
  return taken is not null and taken = p_holder;
end;
$$;

-- Release only the caller's own lease, never one another holder took after it expired.
create or replace function public.release_relayer_lock(p_relayer text, p_holder text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.relayer_locks
  where relayer = lower(p_relayer) and holder = p_holder;
end;
$$;

revoke all on table public.relayer_locks from anon, authenticated;
grant all on table public.relayer_locks to service_role;
revoke all on function public.try_relayer_lock(text, text, integer) from public, anon, authenticated;
grant execute on function public.try_relayer_lock(text, text, integer) to service_role;
revoke all on function public.release_relayer_lock(text, text) from public, anon, authenticated;
grant execute on function public.release_relayer_lock(text, text) to service_role;

do $$
begin
  if to_regclass('public.relayer_locks') is null then
    raise exception 'public.relayer_locks is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.relayer_locks'::regclass) then
    raise exception 'row level security is off on public.relayer_locks';
  end if;
  if to_regprocedure('public.try_relayer_lock(text, text, integer)') is null then
    raise exception 'function try_relayer_lock is missing';
  end if;
  if to_regprocedure('public.release_relayer_lock(text, text)') is null then
    raise exception 'function release_relayer_lock is missing';
  end if;
  if has_function_privilege('anon', 'public.try_relayer_lock(text, text, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.try_relayer_lock(text, text, integer)', 'execute') then
    raise exception 'try_relayer_lock is executable by anon or authenticated';
  end if;
end;
$$;
