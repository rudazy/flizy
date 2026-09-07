-- A payment request can be addressed to any identity a send can reach, not
-- only to a phone.
--
-- Sends have reached a Flizy @username, GitHub, Discord, X, Telegram and email
-- since the Stage 1 identity work. Requests never caught up: the only recipient
-- column was from_wa_hint, so asking someone for money meant knowing their
-- phone number. This generalizes the recipient exactly the way
-- 20260801130000_claim_platform_recipient.sql generalized it for claims, and
-- deliberately uses the same column names so lib/claimRecipient.js serves both
-- tables without a second matching implementation.
--
-- Exactly one mode per request:
--   account   from_account_id set, every other recipient column null
--   phone     from_wa_hint set,    every other recipient column null
--   platform  from_channel and from_external_id set, the others null
--   email     from_email set,      the others null
--
-- The account mode is the one a split bill will use most: you ask people you
-- already know by @username, and a Flizy account is a stabler address than any
-- single identity on it -- someone can unlink a Telegram and keep the account.
-- Claims have no equivalent because a claim exists precisely for a recipient
-- who is not on Flizy yet; a request is aimed at someone who can be told.
--
-- from_external_id is the platform's IMMUTABLE numeric user id, never the
-- handle. Handles are renamed and reassigned; matching on one would show a
-- request to whoever picked up the name afterwards.
--
-- from_display_handle exists only so a menu can say "@ada" instead of
-- "telegram user 55501". Written once at request time, shown to humans, never
-- read as a match key. Attacker-controlled text: render through
-- displaySafeLabel, exactly like the existing from_label.
--
-- SAFETY: verified against the live table before writing this. payment_requests
-- held 4 rows -- 3 paid, 1 cancelled, none pending -- and from_wa_hint was set
-- and non-blank on every one, so the mode constraint validates with no backfill
-- and there is no in-flight request to migrate.
--
-- It also adds bill_id, which is all a split bill needs. There is deliberately
-- no bills table: the total is the sum of the rows, the creator is the same
-- requester_account_id on every one, and the status is derived from them, so a
-- table would be a second copy of four facts for the sake of one label. Same
-- argument as the frozen credit ledger, which is derived rather than stored.
--
-- What would force a real table later, none of which is split bill:
--   a pot that exists before anyone is asked (nothing to hang a bill_id on)
--   money arriving outside a per-person request
--   renaming a bill after the fact, since bill_note is repeated per row
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.payment_requests
  add column if not exists from_account_id uuid references public.accounts (id) on delete cascade,
  add column if not exists from_channel text,
  add column if not exists from_external_id text,
  add column if not exists from_display_handle text,
  add column if not exists from_email text,
  add column if not exists bill_id uuid,
  add column if not exists bill_note text;

-- ---------------------------------------------------------------------------
-- 2. The channel must be one the system knows
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payment_requests_from_channel_check'
  ) then
    alter table public.payment_requests
      add constraint payment_requests_from_channel_check
      check (
        from_channel is null
        or from_channel in ('whatsapp', 'telegram', 'x', 'github', 'discord')
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Exactly one addressing mode, never two, never none
-- ---------------------------------------------------------------------------

-- Without this a request could carry a phone AND a platform id, and both match
-- paths would find it: two different people would each be shown a request to
-- pay. Only one payment can settle it, because beginRequestProcessing takes the
-- row first, but the other person was shown a bill that was never theirs.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payment_requests_recipient_mode_check'
  ) then
    alter table public.payment_requests
      add constraint payment_requests_recipient_mode_check
      check (
        (
          from_account_id is not null
          and from_wa_hint is null
          and from_channel is null
          and from_external_id is null
          and from_email is null
        )
        or (
          from_wa_hint is not null
          and btrim(from_wa_hint) <> ''
          and from_account_id is null
          and from_channel is null
          and from_external_id is null
          and from_email is null
        )
        or (
          from_channel is not null
          and from_external_id is not null
          and btrim(from_external_id) <> ''
          and from_account_id is null
          and from_wa_hint is null
          and from_email is null
        )
        or (
          from_email is not null
          and btrim(from_email) <> ''
          and from_account_id is null
          and from_wa_hint is null
          and from_channel is null
          and from_external_id is null
        )
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Lookup paths for the new modes
-- ---------------------------------------------------------------------------

-- Mirror payment_requests_from_wa_status_idx. Partial, because only the new
-- modes carry these columns and the phone rows would otherwise bloat them.
create index if not exists payment_requests_from_platform_status_idx
  on public.payment_requests (from_channel, from_external_id, status)
  where from_channel is not null;

create index if not exists payment_requests_from_email_status_idx
  on public.payment_requests (from_email, status)
  where from_email is not null;

-- One split is one bill_id. The status is in the key because every read of a
-- bill asks the same question: how much of it is still outstanding.
create index if not exists payment_requests_bill_status_idx
  on public.payment_requests (bill_id, status)
  where bill_id is not null;

create index if not exists payment_requests_from_account_status_idx
  on public.payment_requests (from_account_id, status)
  where from_account_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Post-condition
-- ---------------------------------------------------------------------------

do $$
declare
  missing text;
begin
  select string_agg(t.name, ', ')
  into missing
  from (values
    ('payment_requests_from_channel_check'),
    ('payment_requests_recipient_mode_check')
  ) as t(name)
  where not exists (select 1 from pg_constraint where conname = t.name);

  if missing is not null then
    raise exception 'payment request recipient constraints missing: %', missing;
  end if;

  select string_agg(t.name, ', ')
  into missing
  from (values
    ('payment_requests_from_platform_status_idx'),
    ('payment_requests_from_email_status_idx'),
    ('payment_requests_from_account_status_idx'),
    ('payment_requests_bill_status_idx')
  ) as t(name)
  where not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = t.name
  );

  if missing is not null then
    raise exception 'payment request recipient indexes missing: %', missing;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payment_requests'
      and column_name = 'from_display_handle'
  ) then
    raise exception 'payment_requests.from_display_handle was not created';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Documentation
-- ---------------------------------------------------------------------------

comment on column public.payment_requests.bill_id is
  'Rows created by one split share this. Null for a standalone request. There is no bills table: the total, the creator and the progress are all derived from the rows that carry this id.';
comment on column public.payment_requests.bill_note is
  'What the split was for, as the organiser typed it. Repeated on every row of the bill, which is the cost of not having a bills table -- renaming would mean updating them all. Attacker-controlled text: render through displaySafeLabel.';
comment on column public.payment_requests.from_account_id is
  'Account-addressed requests only. Set when the payer was named by @username, which resolves to a Flizy account. A stabler address than any one identity on that account. Null otherwise.';
comment on column public.payment_requests.from_wa_hint is
  'Phone-addressed requests only. Normalized phone digits the request is aimed at. Visible to the payer once that phone is proven on an account. Null for platform and email requests.';
comment on column public.payment_requests.from_channel is
  'Platform-addressed requests only. Channel the payer identity lives on. Null otherwise.';
comment on column public.payment_requests.from_external_id is
  'Platform-addressed requests only. The platform''s immutable numeric user id, never the handle: handles are renamed and reassigned, ids are not.';
comment on column public.payment_requests.from_display_handle is
  'Display only, never a match key. The handle as it read when the request was created, so a menu can name a person instead of an id. Attacker-controlled text: render through displaySafeLabel.';
comment on column public.payment_requests.from_email is
  'Email-addressed requests only. Normalized address the request is aimed at. Visible once that address is verified on an account. Null otherwise.';
