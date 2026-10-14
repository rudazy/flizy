-- Lock the browser roles out of the public schema.
--
-- Every Supabase call this app makes is server side with the service_role key.
-- anon and authenticated have no job here, and neither has PUBLIC (the
-- everyone pseudo-role, which anon and authenticated inherit from). End state:
--
--   1. RLS on for every public table (no policies; service_role bypasses).
--   2. anon and authenticated hold nothing on any public table, view, sequence
--      or function, and PUBLIC holds no EXECUTE on any public function.
--   3. service_role keeps everything it uses: EXECUTE is granted to it
--      explicitly before PUBLIC loses it, because some functions (trigger
--      helpers such as username_reserved_key) only reached it through PUBLIC.
--   4. Every SECURITY DEFINER function has a pinned search_path.
--   5. New tables, sequences and functions created by the role that runs
--      migrations start with no anon, authenticated or PUBLIC access. This is
--      the root cause behind account_emails and email_verifications: they
--      inherited Supabase's default grants to anon and authenticated.
--   6. schema_guard_objects() also reports what the browser roles can reach,
--      so the startup guard, the build gate and the daily check can enforce 1-5
--      as a rule instead of mirroring what the migrations declare.
--
-- Objects owned by a role the running role cannot act for (Supabase-managed
-- objects owned by supabase_admin, for example) cannot be changed from here.
-- They are skipped with a WARNING naming each one, left out of the
-- post-conditions, and still reported by the guard.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. RLS on every public table
-- ---------------------------------------------------------------------------

do $$
declare
  rel record;
begin
  for rel in
    select c.oid::regclass as name, pg_has_role(c.relowner, 'USAGE') as can_alter
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    if rel.can_alter then
      execute format('alter table %s enable row level security', rel.name);
    else
      raise warning 'skipped % (not owned by %): row level security is still off', rel.name, current_user;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. service_role first, then revoke the browser roles
-- ---------------------------------------------------------------------------

do $$
declare
  obj record;
begin
  -- Functions and procedures: grant service_role before PUBLIC goes away.
  for obj in
    select p.oid, p.oid::regprocedure as name,
           case p.prokind when 'p' then 'procedure' else 'function' end as kind,
           pg_has_role(p.proowner, 'USAGE') as can_alter
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p')
  loop
    if obj.can_alter then
      execute format('grant execute on %s %s to service_role', obj.kind, obj.name);
      execute format('revoke all on %s %s from public, anon, authenticated', obj.kind, obj.name);
    elsif has_function_privilege('anon', obj.oid, 'execute')
       or has_function_privilege('authenticated', obj.oid, 'execute') then
      raise warning 'skipped % (not owned by %): browser roles can still execute it', obj.name, current_user;
    end if;
  end loop;

  -- Tables, views, materialized views, foreign tables and sequences. Revoking
  -- on the table also revokes any column-level grants on it. service_role's
  -- table grants are left exactly as they are: the append-only tables
  -- (identity_events, invite_events, invite_phone_claims) revoke UPDATE and
  -- DELETE from it on purpose.
  for obj in
    select c.oid::regclass as name,
           case c.relkind when 'S' then 'sequence' else 'table' end as kind,
           pg_has_role(c.relowner, 'USAGE') as can_alter,
           exists (
             select 1
             from aclexplode(coalesce(c.relacl, acldefault(
               case when c.relkind = 'S' then 's' else 'r' end::"char", c.relowner))) a
             where a.grantee = 0
                or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated'))
           ) as exposed
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  loop
    if obj.can_alter then
      execute format('revoke all on %s %s from public, anon, authenticated', obj.kind, obj.name);
    elsif obj.exposed then
      raise warning 'skipped % (not owned by %): browser roles still hold grants on it', obj.name, current_user;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Pin search_path on the SECURITY DEFINER functions that left pg_temp out
-- ---------------------------------------------------------------------------
--
-- With pg_temp not listed, the temporary schema is searched first for tables,
-- so a caller able to create temp tables could shadow public.users inside a
-- function running as its owner. Only service_role can call these, but a
-- definer function should not depend on that.

alter function public.debit_user_balance(uuid, numeric) set search_path = public, pg_temp;
alter function public.credit_user_balance(uuid, numeric) set search_path = public, pg_temp;
alter function public.bump_signup_attempts(text, bigint, integer) set search_path = public, pg_temp;
alter function public.bump_generation_usage(uuid, timestamptz, text, integer, integer) set search_path = public, pg_temp;
alter function public.claim_background_upload(uuid) set search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 4. Default privileges for whatever this migration's role creates next
-- ---------------------------------------------------------------------------
--
-- Written against current_user rather than a hard-coded name: the defaults
-- that matter belong to the role that creates the objects, which is the role
-- running the migrations (postgres, in the dashboard SQL editor and in
-- scripts/run-dev-migrations.js).
--
-- The PUBLIC EXECUTE default for functions is built into PostgreSQL and can
-- only be removed globally (a per-schema default can add, never subtract), so
-- that one line applies to functions this role creates in any schema.

do $$
begin
  execute format('alter default privileges for role %I in schema public revoke all on tables from anon, authenticated', current_user);
  execute format('alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated', current_user);
  execute format('alter default privileges for role %I in schema public revoke all on functions from anon, authenticated', current_user);
  execute format('alter default privileges for role %I revoke execute on functions from public', current_user);

  execute format('alter default privileges for role %I in schema public grant all on tables to service_role', current_user);
  execute format('alter default privileges for role %I in schema public grant all on sequences to service_role', current_user);
  execute format('alter default privileges for role %I in schema public grant execute on functions to service_role', current_user);
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Introspection function, now with what the browser roles can reach
-- ---------------------------------------------------------------------------
--
-- 'exposure' reports facts, not verdicts: every grant held by anon,
-- authenticated or PUBLIC, every SECURITY DEFINER function with its
-- search_path, and default privileges for new objects. The rule (and the
-- committed allowlist) lives in lib/schemaGuard.js and its web mirror, so it
-- is unit tested without a database.
--
-- default_acl includes the built-in PUBLIC EXECUTE default for functions,
-- resolved for the role that owns this function (the migration role). It has
-- no pg_default_acl row until it is changed, so reading the table alone would
-- hide it.

create or replace function public.schema_guard_objects()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with browser_roles as (
    select 0::oid as oid, 'PUBLIC'::text as name
    union all
    select oid, rolname::text from pg_roles where rolname in ('anon', 'authenticated')
  )
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
    'checks', (
      select coalesce(jsonb_agg(c.relname || '.' || k.conname order by c.relname, k.conname), '[]'::jsonb)
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and k.contype = 'c'
    ),
    'rls_enabled', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    ),
    'exposure', jsonb_build_object(
      'relation_grants', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'name', x.name, 'type', x.type, 'grantee', x.grantee, 'privileges', x.privileges
        ) order by x.name, x.grantee), '[]'::jsonb)
        from (
          select c.relname::text as name,
                 case c.relkind when 'S' then 'sequence' when 'v' then 'view'
                   when 'm' then 'materialized view' when 'f' then 'foreign table'
                   else 'table' end as type,
                 r.name as grantee,
                 jsonb_agg(a.privilege_type order by a.privilege_type) as privileges
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          cross join lateral aclexplode(coalesce(c.relacl, acldefault(
            case when c.relkind = 'S' then 's' else 'r' end::"char", c.relowner))) a
          join browser_roles r on r.oid = a.grantee
          where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
          group by c.relname, c.relkind, r.name
          union all
          select c.relname || '.' || att.attname, 'column', r.name,
                 jsonb_agg(a.privilege_type order by a.privilege_type)
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute att on att.attrelid = c.oid
            and att.attnum > 0 and not att.attisdropped and att.attacl is not null
          cross join lateral aclexplode(att.attacl) a
          join browser_roles r on r.oid = a.grantee
          where n.nspname = 'public'
          group by c.relname, att.attname, r.name
        ) x
      ),
      'function_execute', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'name', x.name, 'grantee', x.grantee, 'security_definer', x.definer
        ) order by x.name, x.grantee), '[]'::jsonb)
        from (
          select p.oid::regprocedure::text as name, r.name as grantee, p.prosecdef as definer
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          join browser_roles r on r.oid = a.grantee
          where n.nspname = 'public' and p.prokind in ('f', 'p') and a.privilege_type = 'EXECUTE'
        ) x
      ),
      'definer_functions', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'name', p.oid::regprocedure::text,
          'search_path', (
            select substr(cfg, 13) from unnest(p.proconfig) cfg where cfg like 'search_path=%'
          )
        ) order by p.oid::regprocedure::text), '[]'::jsonb)
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
      ),
      'default_acl', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'role', x.role, 'schema', x.schema, 'object_type', x.object_type,
          'grantee', x.grantee, 'privileges', x.privileges
        ) order by x.role, x.schema, x.object_type, x.grantee), '[]'::jsonb)
        from (
          select pg_get_userbyid(d.defaclrole)::text as role,
                 coalesce(n.nspname::text, '*') as schema,
                 case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences'
                   else 'functions' end as object_type,
                 r.name as grantee,
                 jsonb_agg(a.privilege_type order by a.privilege_type) as privileges
          from pg_default_acl d
          left join pg_namespace n on n.oid = d.defaclnamespace
          cross join lateral aclexplode(d.defaclacl) a
          join browser_roles r on r.oid = a.grantee
          where (d.defaclnamespace = 0 or n.nspname = 'public')
            and d.defaclobjtype in ('r', 'S', 'f')
          group by d.defaclrole, n.nspname, d.defaclobjtype, r.name
          union all
          -- The built-in function default, only while this role has no
          -- global functions row (once it has one, the row above covers it).
          select current_user::text, '*', 'functions', 'PUBLIC', '["EXECUTE"]'::jsonb
          where not exists (
            select 1 from pg_default_acl d
            where d.defaclrole = (select oid from pg_roles where rolname = current_user)
              and d.defaclnamespace = 0 and d.defaclobjtype = 'f'
          )
        ) x
      )
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
  'Startup schema guard introspection. Returns public-schema object, check constraint and column names, and what anon, authenticated and PUBLIC can reach, for lib/schemaGuard.js. Read only, no row data.';

revoke all on function public.schema_guard_objects() from public, anon, authenticated;
grant execute on function public.schema_guard_objects() to service_role;

-- ---------------------------------------------------------------------------
-- 6. Post-conditions
-- ---------------------------------------------------------------------------

do $$
declare
  leftover text;
  payload jsonb;
begin
  select string_agg(c.relname, ', ' order by c.relname) into leftover
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
    and pg_has_role(c.relowner, 'USAGE');
  if leftover is not null then
    raise exception 'row level security is still off on: %', leftover;
  end if;

  select string_agg(distinct c.relname, ', ') into leftover
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault(
    case when c.relkind = 'S' then 's' else 'r' end::"char", c.relowner))) a
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and pg_has_role(c.relowner, 'USAGE')
    and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')));
  if leftover is not null then
    raise exception 'anon, authenticated or PUBLIC still hold grants on: %', leftover;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into leftover
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f', 'p')
    and pg_has_role(p.proowner, 'USAGE')
    and (has_function_privilege('anon', p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute'));
  if leftover is not null then
    raise exception 'anon or authenticated can still execute: %', leftover;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into leftover
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f', 'p')
    and not has_function_privilege('service_role', p.oid, 'execute');
  if leftover is not null then
    raise exception 'service_role lost EXECUTE on: %', leftover;
  end if;

  select string_agg(c.relname, ', ' order by c.relname) into leftover
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
    and not has_table_privilege('service_role', c.oid, 'SELECT');
  if leftover is not null then
    raise exception 'service_role cannot SELECT from: %', leftover;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into leftover
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and pg_has_role(p.proowner, 'USAGE')
    and not exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%');
  if leftover is not null then
    raise exception 'SECURITY DEFINER functions without a pinned search_path: %', leftover;
  end if;

  payload := public.schema_guard_objects();
  if jsonb_typeof(payload -> 'exposure') <> 'object' then
    raise exception 'schema_guard_objects did not return an exposure report';
  end if;

  select string_agg(e ->> 'object_type' || ' to ' || (e ->> 'grantee'), ', ') into leftover
  from jsonb_array_elements(payload -> 'exposure' -> 'default_acl') e
  where e ->> 'role' = current_user;
  if leftover is not null then
    raise exception 'default privileges for % still grant: %', current_user, leftover;
  end if;
end
$$;
