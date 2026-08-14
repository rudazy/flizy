-- Allow email_verifications.purpose = 'login' for new-browser / stale-device
-- login codes. Primary and secondary ownership codes are unchanged.
--
-- Idempotent: safe to run twice.

alter table public.email_verifications
  drop constraint if exists email_verifications_purpose_check;

alter table public.email_verifications
  add constraint email_verifications_purpose_check
  check (purpose in ('primary', 'secondary', 'login'));

comment on column public.email_verifications.purpose is
  'primary = registration inbox, secondary = extra email, login = new or stale browser';

do $$
declare
  def text;
begin
  select pg_get_constraintdef(c.oid) into def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'email_verifications'
    and c.conname = 'email_verifications_purpose_check';
  if def is null or def not ilike '%login%' then
    raise exception 'email_verifications_purpose_check does not allow login';
  end if;
end
$$;
