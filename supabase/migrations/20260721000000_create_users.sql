-- Flizy users: WhatsApp phone -> custodial mapping metadata
-- MVP uses a shared bot wallet; wallet_address stores the user's known/on-file address if set.

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  wallet_address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_phone_unique unique (phone),
  constraint users_phone_nonempty check (char_length(trim(phone)) > 0)
);

create index if not exists users_phone_idx on public.users (phone);
create index if not exists users_wallet_address_idx on public.users (wallet_address)
  where wallet_address is not null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
  before update on public.users
  for each row
  execute function public.set_updated_at();

alter table public.users enable row level security;

-- Bot uses service role key (bypasses RLS). No public anon policies by default.
-- Keep table locked unless a policy is added intentionally.

comment on table public.users is 'WhatsApp identities for Flizy bot';
comment on column public.users.phone is 'WhatsApp chat id, e.g. 234xxxxxxxxxx@c.us';
comment on column public.users.wallet_address is 'Optional known EVM address for the user';
