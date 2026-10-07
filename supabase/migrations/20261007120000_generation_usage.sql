-- Usage counter for paid collection generation.
--
-- Paying the generation fee opens a 24 hour window in which the account can
-- store images and metadata on IPFS and have the AI draw trait layers. Both
-- cost Flizy money per call, so each window carries a quota, counted here.
-- The window is identified by the created_at of the fee payment's transfers
-- row, so a new payment starts a fresh count and nothing needs resetting.
-- AI plans come before the payment, so their window is the UTC day instead.
--
-- Additive only. Re-running is safe.

create table if not exists public.generation_usage (
  account_id uuid not null references public.accounts (id) on delete cascade,
  window_paid_at timestamptz not null,
  kind text not null,
  used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (account_id, window_paid_at, kind),
  constraint generation_usage_kind_check check (kind in ('pin_image', 'pin_metadata', 'ai_plan', 'ai_image')),
  constraint generation_usage_used_check check (used >= 0)
);

create index if not exists generation_usage_updated_idx
  on public.generation_usage (updated_at);

alter table public.generation_usage enable row level security;

revoke all on table public.generation_usage from anon, authenticated;
grant all on table public.generation_usage to service_role;

comment on table public.generation_usage is
  'Per fee window usage of paid generation services (IPFS pins, AI calls).';

-- Count p_amount units against the window's quota in one statement.
--
-- The update only applies when the new total stays within p_max, so two
-- concurrent requests cannot both pass on the last units: the row lock taken
-- by insert .. on conflict serialises them and the second sees the first's
-- total. Out params are named so none collides with a column.
create or replace function public.bump_generation_usage(
  p_account_id uuid,
  p_window_paid_at timestamptz,
  p_kind text,
  p_amount integer,
  p_max integer
)
returns table (allowed boolean, total integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
begin
  if p_amount < 1 or p_amount > p_max then
    allowed := false;
    total := null;
    return next;
    return;
  end if;

  insert into public.generation_usage as g (account_id, window_paid_at, kind, used, updated_at)
  values (p_account_id, p_window_paid_at, p_kind, p_amount, now())
  on conflict (account_id, window_paid_at, kind) do update
    set used = g.used + p_amount,
        updated_at = now()
    where g.used + p_amount <= p_max
  returning g.used into v_used;

  -- Sampled cleanup of windows long closed.
  if random() < 0.01 then
    delete from public.generation_usage where updated_at < now() - interval '7 days';
  end if;

  if v_used is null then
    select g.used into v_used
    from public.generation_usage g
    where g.account_id = p_account_id and g.window_paid_at = p_window_paid_at and g.kind = p_kind;
    allowed := false;
  else
    allowed := true;
  end if;
  total := v_used;
  return next;
end;
$$;

revoke all on function public.bump_generation_usage(uuid, timestamptz, text, integer, integer) from public, anon, authenticated;
grant execute on function public.bump_generation_usage(uuid, timestamptz, text, integer, integer) to service_role;

comment on function public.bump_generation_usage(uuid, timestamptz, text, integer, integer) is
  'Atomically count paid generation usage against a fee window quota and say whether it is allowed.';

do $$
begin
  if to_regclass('public.generation_usage') is null then
    raise exception 'generation_usage is missing';
  end if;
  if to_regproc('public.bump_generation_usage') is null then
    raise exception 'bump_generation_usage is missing';
  end if;
end
$$;
