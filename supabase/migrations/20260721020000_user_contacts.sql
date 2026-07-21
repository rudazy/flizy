-- Per-user address book: "send 0.01 to ama" resolves to a saved 0x address

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  owner_phone text not null,
  alias text not null,
  address text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_alias_nonempty check (char_length(trim(alias)) > 0),
  constraint contacts_alias_format check (alias ~ '^[a-zA-Z][a-zA-Z0-9_]{0,31}$'),
  constraint contacts_owner_alias_unique unique (owner_phone, alias)
);

create index if not exists contacts_owner_phone_idx on public.contacts (owner_phone);
create index if not exists contacts_user_id_idx on public.contacts (user_id);

drop trigger if exists contacts_set_updated_at on public.contacts;
create trigger contacts_set_updated_at
  before update on public.contacts
  for each row
  execute function public.set_updated_at();

alter table public.contacts enable row level security;

comment on table public.contacts is 'Named wallet aliases per Flizy WhatsApp user';
comment on column public.contacts.alias is 'Case-insensitive name, e.g. ama → send 0.01 to ama';
