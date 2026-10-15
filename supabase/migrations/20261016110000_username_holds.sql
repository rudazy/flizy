-- Hold a released @username for its last owner.
--
-- A changed username used to be free for anyone the moment it was released.
-- Links and QR codes printed with the old name (/pay/oldname, "pay @oldname")
-- would then pay whoever took it next. Now the old name is held for 90 days
-- for the account that released it: nobody else can take it in that time, and
-- the account that released it can take it back.
--
-- Enforced by a trigger on accounts, not by the routes, so every writer of
-- accounts.username is covered and two concurrent renames cannot both win.
-- A name held for someone else is refused with errcode FZ003, which the site
-- answers with the same "not available" copy as a taken or reserved name.
--
-- Keys are lower(btrim(username)), the same expression as the unique index
-- accounts_username_lower_uidx.
--
-- Not security definer: only service_role writes accounts, and it bypasses
-- RLS, so the trigger needs nothing it does not already have. search_path is
-- pinned anyway.
--
-- Idempotent: safe to run twice.

create table if not exists public.username_holds (
  username_key text primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  held_until timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table public.username_holds is
  'Usernames released by a rename, held for the releasing account until held_until. Written only by trigger accounts_username_hold.';

alter table public.username_holds enable row level security;
revoke all on table public.username_holds from public, anon, authenticated;
grant all on table public.username_holds to service_role;

create or replace function public.accounts_hold_released_username()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  next_key text;
  old_key text;
begin
  if new.username is not null and btrim(new.username) <> '' then
    next_key := lower(btrim(new.username));
    if exists (
      select 1
      from public.username_holds h
      where h.username_key = next_key
        and h.held_until > now()
        and h.account_id <> new.id
    ) then
      raise exception 'username is held'
        using errcode = 'FZ003',
              detail = 'username was released by another account and is still held for it';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.username is not null and btrim(old.username) <> '' then
    old_key := lower(btrim(old.username));
    if old_key is distinct from next_key then
      insert into public.username_holds (username_key, account_id, held_until)
      values (old_key, old.id, now() + interval '90 days')
      on conflict (username_key) do update
        set account_id = excluded.account_id,
            held_until = excluded.held_until;
    end if;
  end if;

  return new;
end
$$;

revoke all on function public.accounts_hold_released_username() from public, anon, authenticated;
grant execute on function public.accounts_hold_released_username() to service_role;

drop trigger if exists accounts_username_hold on public.accounts;
create trigger accounts_username_hold
  before insert or update of username
  on public.accounts
  for each row
  execute function public.accounts_hold_released_username();

do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'username_holds' and c.relrowsecurity
  ) then
    raise exception 'username_holds missing or RLS off after migration';
  end if;
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'accounts' and t.tgname = 'accounts_username_hold' and not t.tgisinternal
  ) then
    raise exception 'trigger accounts_username_hold missing after migration';
  end if;
end
$$;
