-- One short pay code per account. QR and typed code resolve to this row.
-- Distinct from @username (invite / recognition). Code is issued, not chosen.
-- Idempotent: safe to run twice.

create table if not exists public.pay_codes (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  code text not null,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pay_codes_code_format'
  ) then
    alter table public.pay_codes
      add constraint pay_codes_code_format
      check (code ~ '^[2-9A-HJ-NP-Z]{6}$');
  end if;
end
$$;

create unique index if not exists pay_codes_code_uidx
  on public.pay_codes (code);

comment on table public.pay_codes is
  'One stable typeable pay code per account. Printed under the pay QR.';

alter table public.pay_codes enable row level security;

revoke all on public.pay_codes from anon, authenticated;

do $$
begin
  if to_regclass('public.pay_codes') is null then
    raise exception 'pay_codes was not created';
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'pay_codes_code_format'
  ) then
    raise exception 'pay_codes_code_format is missing';
  end if;
  if to_regclass('public.pay_codes_code_uidx') is null then
    raise exception 'pay_codes_code_uidx is missing';
  end if;
end
$$;
