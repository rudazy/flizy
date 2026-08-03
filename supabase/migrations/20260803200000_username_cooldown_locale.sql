-- Username change cooldown + UI language preference.
-- @username stays ASCII recognition only; display_name may be any language.
-- locale drives the web UI language picker (en / ko / zh …).

alter table public.accounts
  add column if not exists username_changed_at timestamptz;

comment on column public.accounts.username_changed_at is
  'When username was last set or changed. Changes allowed at most once per 30 days.';

alter table public.accounts
  add column if not exists locale text;

comment on column public.accounts.locale is
  'Preferred UI language code: en, ko, zh. Null means default (en) or client cookie.';

-- Existing rows with a username: stamp now so cooldown starts (they already chose a name).
update public.accounts
set username_changed_at = coalesce(username_changed_at, now())
where username is not null
  and length(trim(username)) > 0
  and username_changed_at is null;

-- Default locale for existing accounts
update public.accounts
set locale = 'en'
where locale is null;

alter table public.accounts
  alter column locale set default 'en';
