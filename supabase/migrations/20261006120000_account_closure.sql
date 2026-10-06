-- Account pause and permanent sign-in close.
--
-- deactivated_at: the person can sign in with the account password and the
-- timestamp is cleared. Chat stays refused until then.
-- deleted_at: the password cannot restore the sign-in. The row stays so the
-- wallet pointer and chain history are not dropped.
-- Re-running is safe.

alter table public.accounts
  add column if not exists deactivated_at timestamptz,
  add column if not exists deleted_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'accounts'
      and column_name = 'deactivated_at'
  ) then
    raise exception 'accounts.deactivated_at is missing';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'accounts'
      and column_name = 'deleted_at'
  ) then
    raise exception 'accounts.deleted_at is missing';
  end if;
end
$$;
