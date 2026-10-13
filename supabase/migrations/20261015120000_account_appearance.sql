-- One background choice per account. The signed-in site reads it and paints
-- it behind that person's dashboard only.
--
-- mode default: the build background. No row is required for that.
-- mode preset: one of the five named themes.
-- mode image: a file in the private user-backgrounds bucket. The path is a
-- random id, never the account id. The account id is not a public value.
--
-- Service role only. The bucket is private and has no storage policy, so the
-- same role is the only reader. The site streams the file itself.
--
-- Additive only. Re-running is safe.

create table if not exists public.account_appearance (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  mode text not null default 'default',
  preset text,
  image_path text,
  dim smallint not null default 60,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.account_appearance is
  'Dashboard background for one account. Private. Not shown to anyone else.';

alter table public.account_appearance enable row level security;

revoke all on table public.account_appearance from anon, authenticated;
grant all on table public.account_appearance to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'user-backgrounds',
  'user-backgrounds',
  false,
  1572864,
  array['image/webp', 'image/jpeg', 'image/png']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Checks. Added when missing so a second run does not fail on the name.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'account_appearance_mode_check'
  ) then
    alter table public.account_appearance
      add constraint account_appearance_mode_check
      check (mode in ('default', 'preset', 'image'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'account_appearance_preset_check'
  ) then
    alter table public.account_appearance
      add constraint account_appearance_preset_check
      check (
        (mode = 'preset' and preset in ('wine', 'green', 'gold', 'yellow', 'white'))
        or (mode <> 'preset' and preset is null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'account_appearance_image_check'
  ) then
    alter table public.account_appearance
      add constraint account_appearance_image_check
      check (
        (mode = 'image' and image_path is not null)
        or (mode <> 'image' and image_path is null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'account_appearance_dim_check'
  ) then
    alter table public.account_appearance
      add constraint account_appearance_dim_check
      check (dim >= 0 and dim <= 90);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'account_appearance_version_check'
  ) then
    alter table public.account_appearance
      add constraint account_appearance_version_check
      check (version >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'account_appearance_path_check'
  ) then
    alter table public.account_appearance
      add constraint account_appearance_path_check
      check (
        image_path is null
        or image_path ~ '^[a-f0-9]{32}\.(webp|jpg|png)$'
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Post-condition
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.account_appearance') is null then
    raise exception 'public.account_appearance is missing';
  end if;

  if not (
    select relrowsecurity from pg_class where oid = 'public.account_appearance'::regclass
  ) then
    raise exception 'public.account_appearance has row level security off';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'account_appearance_mode_check'
  ) then
    raise exception 'account_appearance_mode_check is missing';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'account_appearance_preset_check'
  ) then
    raise exception 'account_appearance_preset_check is missing';
  end if;

  if not exists (
    select 1 from storage.buckets
    where id = 'user-backgrounds' and public = false
  ) then
    raise exception 'user-backgrounds bucket is missing or public';
  end if;
end $$;
