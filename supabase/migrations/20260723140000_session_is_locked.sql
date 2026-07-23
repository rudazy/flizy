-- Explicit WA lock state: default unlocked until user runs flizy lock.
alter table public.sessions
  add column if not exists is_locked boolean not null default false;

comment on column public.sessions.is_locked is
  'True after flizy lock. Unlocked only via flizy unlock + password/PIN.';
