-- When Flizy verified a project. Null means the project is Standard.
--
-- Set by hand in the SQL Editor after Flizy has checked the project; no route
-- writes it. Only the service role can write public.projects, so an owner
-- cannot verify their own project. The project page, task cards and the
-- owner's project list show a Verified badge while it is set.
--
--   update public.projects set verified_at = now() where handle = '<handle>';
--   update public.projects set verified_at = null where handle = '<handle>';
--
-- Additive only. Re-running is safe.

alter table public.projects
  add column if not exists verified_at timestamptz;

comment on column public.projects.verified_at is
  'When Flizy verified this project. Null: Standard. Set by hand, never by a route.';

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'projects'
      and column_name = 'verified_at'
  ) then
    raise exception 'projects.verified_at is missing';
  end if;
end $$;
