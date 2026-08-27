-- One in-flight site money move per account.
-- Stops double-click / two-tab POST /api/pay/execute (and swap, LP) from
-- broadcasting two txs from the same agent wallet.
--
-- Chat confirm is already serialized in-process (pendingSends.delete before
-- await). Claims already use pending -> processing. This lock is for Vercel
-- routes, where each request is a separate isolate and an in-memory Map is
-- useless.
--
-- Idempotent: safe to run twice.

create table if not exists public.account_tx_locks (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  kind text not null,
  created_at timestamptz not null default now()
);

alter table public.account_tx_locks enable row level security;

comment on table public.account_tx_locks is
  'At most one in-flight site payment/swap/LP per account. Service role only.';

create or replace function public.try_account_tx_lock(
  p_account_id uuid,
  p_kind text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_account_id is null then
    return false;
  end if;

  -- Crashed request must not freeze the account. Two minutes covers a slow
  -- tx.wait without letting a second click through during a live send.
  delete from public.account_tx_locks
   where account_id = p_account_id
     and created_at < now() - interval '2 minutes';

  begin
    insert into public.account_tx_locks (account_id, kind)
    values (p_account_id, coalesce(nullif(btrim(p_kind), ''), 'tx'));
    return true;
  exception
    when unique_violation then
      return false;
  end;
end;
$$;

create or replace function public.release_account_tx_lock(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_account_id is null then
    return;
  end if;
  delete from public.account_tx_locks where account_id = p_account_id;
end;
$$;

revoke all on function public.try_account_tx_lock(uuid, text) from public;
revoke all on function public.try_account_tx_lock(uuid, text) from anon;
revoke all on function public.try_account_tx_lock(uuid, text) from authenticated;
grant execute on function public.try_account_tx_lock(uuid, text) to service_role;

revoke all on function public.release_account_tx_lock(uuid) from public;
revoke all on function public.release_account_tx_lock(uuid) from anon;
revoke all on function public.release_account_tx_lock(uuid) from authenticated;
grant execute on function public.release_account_tx_lock(uuid) to service_role;

revoke all on table public.account_tx_locks from anon, authenticated;
grant all on table public.account_tx_locks to service_role;

comment on function public.try_account_tx_lock(uuid, text) is
  'Take the per-account site money lock. False if another request still holds it.';
comment on function public.release_account_tx_lock(uuid) is
  'Drop the per-account site money lock after the chain call returns.';

do $$
begin
  if to_regclass('public.account_tx_locks') is null then
    raise exception 'account_tx_locks is missing';
  end if;
  if to_regprocedure('public.try_account_tx_lock(uuid, text)') is null then
    raise exception 'try_account_tx_lock is missing';
  end if;
  if to_regprocedure('public.release_account_tx_lock(uuid)') is null then
    raise exception 'release_account_tx_lock is missing';
  end if;
end
$$;
