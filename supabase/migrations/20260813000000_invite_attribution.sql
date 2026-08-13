-- Invite codes, set-once attribution, and the counting gate.
--
-- A counted invite requires: invite-link attribution, finished onboarding
-- (email verified + username), a currently bound verified phone, and a
-- qualifying first tx. The phone that produced a count is remembered forever
-- in invite_phone_claims so unlink cannot recycle a SIM for a second credit.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. invite_codes
-- ---------------------------------------------------------------------------

create table if not exists public.invite_codes (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  code text not null,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'invite_codes_code_format'
  ) then
    alter table public.invite_codes
      add constraint invite_codes_code_format
      check (code ~ '^[0-9a-hjkmnp-tv-z]{10}$');
  end if;
end
$$;

create unique index if not exists invite_codes_code_uidx
  on public.invite_codes (code);

comment on table public.invite_codes is
  'One stable public invite slug per account. Issued after username. Not user-chosen.';

-- ---------------------------------------------------------------------------
-- 2. invite_attributions
-- ---------------------------------------------------------------------------

create table if not exists public.invite_attributions (
  invitee_account_id uuid primary key references public.accounts (id) on delete restrict,
  inviter_account_id uuid not null references public.accounts (id),
  invite_code text not null,
  source text not null,
  attributed_at timestamptz not null default now(),
  onboarding_completed_at timestamptz,
  first_tx_at timestamptz,
  counted_at timestamptz,
  count_blocked_reason text
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'invite_attributions_not_self'
  ) then
    alter table public.invite_attributions
      add constraint invite_attributions_not_self
      check (invitee_account_id <> inviter_account_id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'invite_attributions_source_check'
  ) then
    alter table public.invite_attributions
      add constraint invite_attributions_source_check
      check (source in ('invite_link'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'invite_attributions_blocked_reason_check'
  ) then
    alter table public.invite_attributions
      add constraint invite_attributions_blocked_reason_check
      check (
        count_blocked_reason is null
        or count_blocked_reason in ('circular', 'phone_spent')
      );
  end if;
end
$$;

create index if not exists invite_attributions_inviter_idx
  on public.invite_attributions (inviter_account_id, counted_at);

comment on table public.invite_attributions is
  'Set-once invitee -> inviter fact. Timestamps only advance from null to a value. Count is counted_at.';

-- Pair is immutable. Progress stamps may only fill a null.
create or replace function public.invite_attributions_set_once()
returns trigger
language plpgsql
as $$
begin
  if new.invitee_account_id is distinct from old.invitee_account_id
     or new.inviter_account_id is distinct from old.inviter_account_id
     or new.invite_code is distinct from old.invite_code
     or new.source is distinct from old.source
     or new.attributed_at is distinct from old.attributed_at then
    raise exception 'invite_attributions pair is immutable'
      using errcode = 'FZ003';
  end if;

  if old.onboarding_completed_at is not null
     and new.onboarding_completed_at is distinct from old.onboarding_completed_at then
    raise exception 'invite_attributions timestamps only advance'
      using errcode = 'FZ003';
  end if;
  if old.first_tx_at is not null
     and new.first_tx_at is distinct from old.first_tx_at then
    raise exception 'invite_attributions timestamps only advance'
      using errcode = 'FZ003';
  end if;
  if old.counted_at is not null
     and new.counted_at is distinct from old.counted_at then
    raise exception 'invite_attributions timestamps only advance'
      using errcode = 'FZ003';
  end if;
  if old.count_blocked_reason is not null
     and new.count_blocked_reason is distinct from old.count_blocked_reason then
    raise exception 'invite_attributions timestamps only advance'
      using errcode = 'FZ003';
  end if;

  return new;
end
$$;

drop trigger if exists invite_attributions_set_once on public.invite_attributions;
create trigger invite_attributions_set_once
  before update on public.invite_attributions
  for each row
  execute function public.invite_attributions_set_once();

-- ---------------------------------------------------------------------------
-- 3. invite_phone_claims (the barrier)
-- ---------------------------------------------------------------------------

create table if not exists public.invite_phone_claims (
  phone_e164 text primary key,
  invitee_account_id uuid not null,
  attribution_invitee_id uuid not null references public.invite_attributions (invitee_account_id),
  claimed_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'invite_phone_claims_phone_format'
  ) then
    alter table public.invite_phone_claims
      add constraint invite_phone_claims_phone_format
      check (phone_e164 ~ '^[0-9]{10,15}$');
  end if;
end
$$;

comment on table public.invite_phone_claims is
  'E.164 that has already produced a counted invite. Append-only. Unlink does not touch this.';

create or replace function public.invite_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only: % is not permitted', tg_table_name, tg_op
    using errcode = 'FZ003';
end
$$;

drop trigger if exists invite_phone_claims_no_update on public.invite_phone_claims;
create trigger invite_phone_claims_no_update
  before update or delete on public.invite_phone_claims
  for each row
  execute function public.invite_append_only();

-- ---------------------------------------------------------------------------
-- 4. invite_events
-- ---------------------------------------------------------------------------

create table if not exists public.invite_events (
  id uuid primary key default gen_random_uuid(),
  invitee_account_id uuid,
  inviter_account_id uuid,
  event_type text not null,
  detail text,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'invite_events_event_type_check'
  ) then
    alter table public.invite_events
      add constraint invite_events_event_type_check
      check (event_type in (
        'ATTRIBUTED',
        'ONBOARDED',
        'FIRST_TX',
        'COUNTED',
        'COUNT_REJECTED'
      ));
  end if;
end
$$;

create index if not exists invite_events_invitee_idx
  on public.invite_events (invitee_account_id, created_at desc);

drop trigger if exists invite_events_no_update on public.invite_events;
create trigger invite_events_no_update
  before update or delete on public.invite_events
  for each row
  execute function public.invite_append_only();

comment on table public.invite_events is
  'Append-only audit of attribution and count outcomes.';

-- ---------------------------------------------------------------------------
-- 5. try_count_invite: one atomic gate, both runtimes call this
-- ---------------------------------------------------------------------------

create or replace function public.try_count_invite(p_invitee uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  attr public.invite_attributions%rowtype;
  phone text;
  phones text[];
  existing_invitee uuid;
begin
  if p_invitee is null then
    return jsonb_build_object('ok', false, 'reason', 'noop');
  end if;

  select * into attr
  from public.invite_attributions
  where invitee_account_id = p_invitee
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'noop');
  end if;

  if attr.counted_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'noop');
  end if;

  if attr.onboarding_completed_at is null or attr.first_tx_at is null then
    return jsonb_build_object('ok', false, 'reason', 'not_ready');
  end if;

  if exists (
    select 1
    from public.invite_attributions r
    where r.invitee_account_id = attr.inviter_account_id
      and r.inviter_account_id = p_invitee
      and r.counted_at is not null
  ) then
    update public.invite_attributions
      set count_blocked_reason = 'circular'
      where invitee_account_id = p_invitee
        and count_blocked_reason is null;
    insert into public.invite_events (
      invitee_account_id, inviter_account_id, event_type, detail
    ) values (
      p_invitee, attr.inviter_account_id, 'COUNT_REJECTED', 'circular'
    );
    return jsonb_build_object('ok', false, 'reason', 'circular');
  end if;

  select coalesce(array_agg(distinct btrim(ci.phone_e164)), '{}')
    into phones
  from public.channel_identities ci
  where ci.account_id = p_invitee
    and ci.phone_e164 is not null
    and btrim(ci.phone_e164) ~ '^[0-9]{10,15}$'
    and not exists (
      select 1
      from public.channel_identities lid
      where lid.account_id = p_invitee
        and lid.channel = 'whatsapp'
        and lid.external_id = btrim(ci.phone_e164)
    );

  if phones is null or coalesce(array_length(phones, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_phone');
  end if;

  foreach phone in array phones
  loop
    begin
      insert into public.invite_phone_claims (
        phone_e164, invitee_account_id, attribution_invitee_id
      ) values (
        phone, p_invitee, p_invitee
      );
    exception
      when unique_violation then
        select c.invitee_account_id into existing_invitee
        from public.invite_phone_claims c
        where c.phone_e164 = phone;
        if existing_invitee is distinct from p_invitee then
          update public.invite_attributions
            set count_blocked_reason = 'phone_spent'
            where invitee_account_id = p_invitee
              and count_blocked_reason is null;
          insert into public.invite_events (
            invitee_account_id, inviter_account_id, event_type, detail
          ) values (
            p_invitee, attr.inviter_account_id, 'COUNT_REJECTED', 'phone_spent'
          );
          return jsonb_build_object('ok', false, 'reason', 'phone_spent');
        end if;
    end;
  end loop;

  update public.invite_attributions
    set counted_at = now()
    where invitee_account_id = p_invitee
      and counted_at is null;

  insert into public.invite_events (
    invitee_account_id, inviter_account_id, event_type, detail
  ) values (
    p_invitee, attr.inviter_account_id, 'COUNTED', null
  );

  return jsonb_build_object('ok', true);
end
$$;

comment on function public.try_count_invite(uuid) is
  'Atomic invite count. Burns current E.164s into invite_phone_claims. Unlink cannot undo that.';

-- ---------------------------------------------------------------------------
-- 6. RLS / grants
-- ---------------------------------------------------------------------------

alter table public.invite_codes enable row level security;
alter table public.invite_attributions enable row level security;
alter table public.invite_phone_claims enable row level security;
alter table public.invite_events enable row level security;

revoke all on public.invite_codes from anon, authenticated;
revoke all on public.invite_attributions from anon, authenticated;
revoke all on public.invite_phone_claims from anon, authenticated;
revoke all on public.invite_events from anon, authenticated;

revoke update, delete on public.invite_phone_claims from anon, authenticated;
revoke update, delete on public.invite_events from anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke update, delete on public.invite_phone_claims from service_role';
    execute 'revoke update, delete on public.invite_events from service_role';
    execute 'grant execute on function public.try_count_invite(uuid) to service_role';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Post-condition
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.invite_codes') is null then
    raise exception 'invite_codes was not created';
  end if;
  if to_regclass('public.invite_attributions') is null then
    raise exception 'invite_attributions was not created';
  end if;
  if to_regclass('public.invite_phone_claims') is null then
    raise exception 'invite_phone_claims was not created';
  end if;
  if to_regclass('public.invite_events') is null then
    raise exception 'invite_events was not created';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'invite_attributions_set_once' and not tgisinternal
  ) then
    raise exception 'invite_attributions_set_once trigger was not created';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'invite_phone_claims_no_update' and not tgisinternal
  ) then
    raise exception 'invite_phone_claims_no_update trigger was not created';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'invite_events_no_update' and not tgisinternal
  ) then
    raise exception 'invite_events_no_update trigger was not created';
  end if;
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'try_count_invite'
  ) then
    raise exception 'try_count_invite was not created';
  end if;
end
$$;
