-- Startup schema guard: one round trip that reports what the public schema
-- actually contains.
--
-- The running code derives, from this repo, the list of objects it depends on,
-- then calls this function once at startup and compares. A missing migration
-- then fails at deploy with the object and the file named, instead of failing
-- silently at a stranger's signup screen.
--
-- Read only. Returns object names and column names, never row data.
--
-- security definer with a pinned search_path: the guard must report the same
-- schema regardless of which role calls it, and execute is revoked from anon
-- and authenticated below so only the service key can read the shape.

-- ---------------------------------------------------------------------------
-- 1. Introspection function
-- ---------------------------------------------------------------------------

create or replace function public.schema_guard_objects()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'tables', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    ),
    'views', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm')
    ),
    'functions', (
      select coalesce(jsonb_agg(distinct p.proname order by p.proname), '[]'::jsonb)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
    ),
    'triggers', (
      select coalesce(jsonb_agg(t.tgname order by t.tgname), '[]'::jsonb)
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal
    ),
    'rls_enabled', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    ),
    -- Reported for diagnosis, not enforced: required columns are not reliably
    -- derivable from supabase-js call sites, so nothing fails on this key.
    'columns', (
      select coalesce(jsonb_object_agg(x.relname, x.cols), '{}'::jsonb)
      from (
        select c.relname, jsonb_agg(a.attname order by a.attnum) as cols
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'public'
          and c.relkind in ('r', 'v', 'm')
          and a.attnum > 0
          and not a.attisdropped
        group by c.relname
      ) x
    )
  );
$$;

comment on function public.schema_guard_objects() is
  'Startup schema guard introspection. Returns public-schema object and column names for the deploy-time check in lib/schemaGuard.js. Read only, no row data.';

-- ---------------------------------------------------------------------------
-- 2. Only the service key may read the schema shape
-- ---------------------------------------------------------------------------

revoke all on function public.schema_guard_objects() from public;
revoke all on function public.schema_guard_objects() from anon, authenticated;
grant execute on function public.schema_guard_objects() to service_role;

-- ---------------------------------------------------------------------------
-- 3. Post-conditions
-- ---------------------------------------------------------------------------

do $$
declare
  payload jsonb;
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'schema_guard_objects'
      and p.prosecdef
  ) then
    raise exception 'schema_guard_objects was not created as security definer';
  end if;

  if has_function_privilege('anon', 'public.schema_guard_objects()', 'execute') then
    raise exception 'anon can still execute schema_guard_objects';
  end if;

  if not has_function_privilege('service_role', 'public.schema_guard_objects()', 'execute') then
    raise exception 'service_role cannot execute schema_guard_objects';
  end if;

  payload := public.schema_guard_objects();

  if payload is null or jsonb_typeof(payload -> 'tables') <> 'array' then
    raise exception 'schema_guard_objects did not return a tables array';
  end if;

  if not (payload -> 'tables' ? 'accounts') then
    raise exception 'schema_guard_objects cannot see public.accounts';
  end if;
end
$$;
