-- Eight background uploads per account per hour.
--
-- A counter kept in the Node process does not limit anything once the site
-- runs as more than one instance: each instance has its own memory, so a
-- signed-in account can upload without a bound. The slot is taken here,
-- before the file is stored. A store that then fails still keeps the slot,
-- so a parallel burst cannot slip past the cap by failing the write.
--
-- One row per account. The primary key is the lock. Stamps older than an
-- hour drop off. The cap and the clock are fixed in this function. The route
-- cannot widen them.
--
-- Account closure sets deleted_at and leaves the accounts row, so the foreign
-- key does not remove this row. The delete path of the closure route does.
--
-- Service role only. Additive. Re-running is safe.

create table if not exists public.account_background_uploads (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  hits timestamptz[] not null default '{}',
  updated_at timestamptz not null default now()
);

comment on table public.account_background_uploads is
  'Upload times for one account background, kept for an hour. Service role only.';

alter table public.account_background_uploads enable row level security;

revoke all on table public.account_background_uploads from anon, authenticated;
grant all on table public.account_background_uploads to service_role;

create or replace function public.claim_background_upload(p_account_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits timestamptz[];
  v_kept timestamptz[];
begin
  if p_account_id is null then
    return false;
  end if;

  insert into public.account_background_uploads (account_id, hits)
  values (p_account_id, '{}')
  on conflict (account_id) do nothing;

  select hits
    into v_hits
  from public.account_background_uploads
  where account_id = p_account_id
  for update;

  v_kept := array(
    select stamp
    from unnest(coalesce(v_hits, array[]::timestamptz[])) as stamp
    where stamp > now() - interval '1 hour'
    order by stamp
  );

  if coalesce(array_length(v_kept, 1), 0) >= 8 then
    update public.account_background_uploads
      set hits = v_kept,
          updated_at = now()
      where account_id = p_account_id;
    return false;
  end if;

  update public.account_background_uploads
    set hits = v_kept || array[now()],
        updated_at = now()
    where account_id = p_account_id;
  return true;
end;
$$;

revoke all on function public.claim_background_upload(uuid) from public, anon, authenticated;
grant execute on function public.claim_background_upload(uuid) to service_role;

comment on function public.claim_background_upload(uuid) is
  'Take one background upload slot for an account. False when the hour already holds eight.';

do $$
begin
  if to_regclass('public.account_background_uploads') is null then
    raise exception 'account_background_uploads is missing';
  end if;

  if not (
    select relrowsecurity from pg_class where oid = 'public.account_background_uploads'::regclass
  ) then
    raise exception 'account_background_uploads has row level security off';
  end if;

  if to_regprocedure('public.claim_background_upload(uuid)') is null then
    raise exception 'claim_background_upload is missing';
  end if;
end
$$;
