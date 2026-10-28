-- Profile visibility, and two more switches on the public profile.
--
-- Private turns every profile switch off. Public turns every profile switch
-- on. After that, each switch can be changed on its own.
--
-- The wallet address and the portfolio value stay off until the account
-- turns them on. Portfolio value is the wallet's ETH balance.
--
-- Idempotent. A partial apply fails the post-condition.

alter table public.accounts
  add column if not exists profile_public boolean not null default true,
  add column if not exists profile_show_wallet boolean not null default false,
  add column if not exists profile_show_portfolio boolean not null default false;

comment on column public.accounts.profile_public is
  'Public turns every profile switch on. Private turns every profile switch off. Search hides a private profile. The direct profile link still opens.';

comment on column public.accounts.profile_show_wallet is
  'When true, the public profile shows this account wallet address. Off until turned on.';

comment on column public.accounts.profile_show_portfolio is
  'When true, the public profile shows this wallet ETH balance. Off until turned on.';

do $$
begin
  if (
    select count(*) from information_schema.columns
    where table_schema = 'public'
      and table_name = 'accounts'
      and column_name in ('profile_public', 'profile_show_wallet', 'profile_show_portfolio')
  ) <> 3 then
    raise exception 'profile visibility columns are missing';
  end if;
end;
$$;
