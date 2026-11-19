-- Accounts: let people who know your email find you.
--
--   accounts.findable_by_email   off by default. On, a chat send to one of the
--                                account's VERIFIED emails shows the sender the
--                                @username and offers a direct send beside the
--                                usual claim hold. Off, a send to that email is
--                                held as a claim and reads exactly like a send
--                                to an address that is not on Flizy, so nobody
--                                can use sends to map emails to accounts.
--
-- Idempotent. A partial apply fails the post-condition.

alter table public.accounts add column if not exists findable_by_email boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'accounts'
      and column_name = 'findable_by_email'
      and data_type = 'boolean'
      and is_nullable = 'NO'
      and column_default = 'false'
  ) then
    raise exception 'accounts.findable_by_email is missing or not a non-null boolean defaulting to false';
  end if;
end
$$;
