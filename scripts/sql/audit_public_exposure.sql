-- Read-only audit: what the browser roles can reach in the public schema.
--
-- One SELECT, one result grid, so the whole report survives a copy and paste
-- out of the dashboard SQL editor. Each row is (section, object, detail).
-- Changes nothing. Safe to run on any project.
--
-- Sections:
--   rls_off              public tables with row level security off
--   relation_grant       privileges anon, authenticated or PUBLIC hold on a
--                        table, view, materialized view or sequence in public
--   column_grant         column-level privileges for the same roles
--   function_execute     public functions anon, authenticated or PUBLIC can run
--   definer_function     every SECURITY DEFINER function in public, whoever
--                        can run it, with its search_path
--   service_role_gap     public tables or functions service_role cannot use
--   view_not_invoker     public views without security_invoker
--   default_acl          default privileges for new objects (public or global)
--   event_trigger        event triggers, enabled state and function
--   policy_count         RLS policies in public (zero expected)
--   schema_usage         who holds USAGE / CREATE on schema public
--   storage_bucket       storage buckets and whether each is public
--
-- PUBLIC below is the everyone pseudo-role (grantee oid 0), not the schema.

with
roles as (
  select 0::oid as oid, 'PUBLIC' as name
  union all select oid, rolname from pg_roles where rolname in ('anon', 'authenticated')
),
rels as (
  select c.oid, c.relname, c.relkind, c.relowner, c.relacl, c.relrowsecurity, c.reloptions
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
funcs as (
  select p.oid, p.proname, p.prosecdef, p.proowner, p.proacl, p.proconfig,
         p.oid::regprocedure::text as signature,
         pg_get_function_result(p.oid) as returns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f', 'p')
),
report as (
  select 'rls_off' as section, relname::text as object,
         case relkind when 'p' then 'partitioned table' else 'table' end as detail
  from rels
  where relkind in ('r', 'p') and not relrowsecurity

  union all
  select 'relation_grant',
         r.relname || ' (' || case r.relkind when 'r' then 'table' when 'p' then 'table'
           when 'v' then 'view' when 'm' then 'matview' when 'S' then 'sequence'
           else 'foreign table' end || ')',
         ro.name || ': ' || string_agg(a.privilege_type, ',' order by a.privilege_type)
  from rels r
  cross join lateral aclexplode(coalesce(r.relacl, acldefault(
    case when r.relkind = 'S' then 's' else 'r' end::"char", r.relowner))) a
  join roles ro on ro.oid = a.grantee
  group by r.relname, r.relkind, ro.name

  union all
  select 'column_grant', r.relname || '.' || att.attname,
         ro.name || ': ' || string_agg(a.privilege_type, ',' order by a.privilege_type)
  from rels r
  join pg_attribute att on att.attrelid = r.oid and att.attnum > 0
    and not att.attisdropped and att.attacl is not null
  cross join lateral aclexplode(att.attacl) a
  join roles ro on ro.oid = a.grantee
  group by r.relname, att.attname, ro.name

  union all
  select 'function_execute', f.signature,
         string_agg(ro.name, ',' order by ro.name)
           || ' | ' || case when f.prosecdef then 'SECURITY DEFINER' else 'invoker' end
           || ' | search_path=' || coalesce((
                select substr(cfg, 13) from unnest(f.proconfig) cfg
                where cfg like 'search_path=%'), 'NOT SET')
           || ' | returns ' || f.returns
  from funcs f
  cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
  join roles ro on ro.oid = a.grantee
  where a.privilege_type = 'EXECUTE'
  group by f.signature, f.prosecdef, f.proconfig, f.returns

  union all
  select 'definer_function', f.signature,
         'owner=' || pg_get_userbyid(f.proowner)
           || ' | search_path=' || coalesce((
                select substr(cfg, 13) from unnest(f.proconfig) cfg
                where cfg like 'search_path=%'), 'NOT SET')
           || ' | returns ' || f.returns
           || ' | executable by: ' || coalesce((
                select string_agg(case when a.grantee = 0 then 'PUBLIC'
                  else pg_get_userbyid(a.grantee) end, ',' order by 1)
                from aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
                where a.privilege_type = 'EXECUTE'), 'nobody')
  from funcs f
  where f.prosecdef

  union all
  select 'service_role_gap', r.relname,
         'missing: ' || concat_ws(',',
           case when not has_table_privilege('service_role', r.oid, 'SELECT') then 'SELECT' end,
           case when not has_table_privilege('service_role', r.oid, 'INSERT') then 'INSERT' end,
           case when not has_table_privilege('service_role', r.oid, 'UPDATE') then 'UPDATE' end,
           case when not has_table_privilege('service_role', r.oid, 'DELETE') then 'DELETE' end)
  from rels r
  where r.relkind in ('r', 'p', 'v', 'm')
    and not (has_table_privilege('service_role', r.oid, 'SELECT')
         and (r.relkind in ('v', 'm') or (
              has_table_privilege('service_role', r.oid, 'INSERT')
          and has_table_privilege('service_role', r.oid, 'UPDATE')
          and has_table_privilege('service_role', r.oid, 'DELETE'))))

  union all
  select 'service_role_gap', f.signature, 'missing: EXECUTE'
  from funcs f
  where not has_function_privilege('service_role', f.oid, 'EXECUTE')

  union all
  select 'view_not_invoker', relname,
         'reloptions=' || coalesce(array_to_string(reloptions, ','), 'none')
  from rels
  where relkind = 'v'
    and not coalesce(reloptions && array['security_invoker=true', 'security_invoker=on',
                                         'security_invoker=1'], false)

  union all
  select 'default_acl',
         'for role ' || pg_get_userbyid(d.defaclrole)
           || coalesce(' in schema ' || n.nspname, ' (all schemas)')
           || ' on ' || case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences'
             when 'f' then 'functions' when 'T' then 'types' when 'n' then 'schemas'
             else d.defaclobjtype::text end,
         array_to_string(d.defaclacl, ' ')
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
  where n.nspname is null or n.nspname = 'public'

  union all
  select 'event_trigger', e.evtname,
         'on ' || e.evtevent || ' | enabled=' || e.evtenabled::text
           || ' | function=' || e.evtfoid::regproc::text
           || ' | owner=' || pg_get_userbyid(e.evtowner)
           || coalesce(' | tags=' || array_to_string(e.evttags, ','), '')
  from pg_event_trigger e

  union all
  select 'policy_count', 'public', count(*)::text
  from pg_policies where schemaname = 'public'

  union all
  select 'schema_usage', 'public',
         case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
           || ': ' || string_agg(a.privilege_type, ',' order by a.privilege_type)
  from pg_namespace n
  cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
  where n.nspname = 'public'
  group by a.grantee

  union all
  select 'storage_bucket', b.id, 'public=' || b.public::text
  from storage.buckets b
)
select section, object, detail
from report
order by section, object, detail;
