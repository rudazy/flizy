-- Activity on a public profile starts hidden. Follower counts stay on
-- profile_show_social. copy_trade is that follower's choice to copy the
-- person they follow. It stores the choice only. It does not send a trade.
--
-- Re-running is safe.

alter table public.accounts
  add column if not exists profile_show_activity boolean not null default false;

alter table public.account_follows
  add column if not exists copy_trade boolean not null default false;

comment on column public.accounts.profile_show_stats is
  'When false, other people do not see this account''s volume or swap count.';

comment on column public.accounts.profile_show_activity is
  'When false, other people see no activity on this profile. Starts off.';

comment on column public.account_follows.copy_trade is
  'When true, this follower asked to copy that account. Nothing is copied yet.';

do $$
begin
  if (
    select count(*) from information_schema.columns
    where table_schema = 'public'
      and (
        (table_name = 'accounts' and column_name = 'profile_show_activity')
        or (table_name = 'account_follows' and column_name = 'copy_trade')
      )
  ) <> 2 then
    raise exception 'activity and copy trade columns are missing';
  end if;
end;
$$;
