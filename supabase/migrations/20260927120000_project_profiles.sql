-- A project profile: a description and the links the project wants public.
--
-- The owner stays on projects.owner_account_id; this migration does not touch it.
-- Both columns are public: the /project/<handle> page shows them. The owner
-- column is never selected for that page. Re-running is safe.

alter table public.projects
  add column if not exists description text not null default '';

alter table public.projects
  add column if not exists links jsonb not null default '[]'::jsonb;

alter table public.projects drop constraint if exists projects_description_len;
alter table public.projects
  add constraint projects_description_len check (char_length(description) <= 800);

alter table public.projects drop constraint if exists projects_links_is_array;
alter table public.projects
  add constraint projects_links_is_array
  check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 20);

comment on column public.projects.description is
  'Public text on /project/<handle>. The owner is not in this column.';
comment on column public.projects.links is
  'Public links, each {kind,label,url}. https only. At most 20.';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'description'
  ) then
    raise exception 'projects.description is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'links'
  ) then
    raise exception 'projects.links is missing';
  end if;
end
$$;
