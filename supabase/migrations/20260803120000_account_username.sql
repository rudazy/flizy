-- Flizy-native username for recognition after onboarding.
-- Platform handles (GitHub/X/Discord) stay for reach; this is not a match key for money.
-- Unique when set; optional at signup; editable on Account with collision checks in app.

alter table public.accounts
  add column if not exists username text;

comment on column public.accounts.username is
  'Flizy @username for display. Not used as a payment routing key. Unique lower(username).';

-- Case-insensitive uniqueness; null usernames allowed (multiple accounts without one)
create unique index if not exists accounts_username_lower_uidx
  on public.accounts (lower(username))
  where username is not null and length(trim(username)) > 0;

do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'accounts_username_lower_uidx'
  ) then
    raise exception 'accounts_username_lower_uidx missing after migration';
  end if;
end $$;
