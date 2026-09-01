-- Pay codes become 9 digits, and every existing code is re-minted.
--
-- Why the format changed: a pay code is printed on paper and typed by hand, so
-- it is the bank-account number of this product -- you hand out the number and
-- the payer sees whose account it is on the confirm screen.
--
-- Why digits: usernames match ^[a-z][a-z0-9]{2,23}$, and the old 6-character
-- alphanumeric codes lowercased into perfectly valid usernames. /pay/{ref}
-- resolves usernames before codes, so anyone could read a shop's code off its
-- printed sheet, register it as their username, and quietly collect payments
-- meant for that shop. A code that starts with a digit can never be a username,
-- so those two namespaces stop overlapping by construction rather than by rule.
--
-- Why NINE and not ten: lib/phone.js reads anything from 10 digits upward as a
-- phone number (PHONE_MIN_DIGITS). A ten-digit code would have parsed as a
-- phone and opened an escrow hold instead of paying the merchant -- and it
-- collides with bare mobile numbers in the US, India, Kenya, Ghana and South
-- Africa. Nine sits below that floor, so a bare code is unambiguous everywhere
-- with no rule for anyone to remember. Ten would also have looked exactly like
-- a Nigerian NUBAN, inviting someone to paste a real bank account number here.
-- test/payCode.test.js asserts the code length stays below the phone floor.
--
-- Re-mint, not dual-format: owner call 2026-09-01. Testnet, 35 codes, and the
-- printed-sheet flow is a day old, so almost certainly nothing is taped to a
-- counter yet. One format is most of the value of the change.
--
-- Existing rows are DELETED rather than rewritten here: they cannot satisfy the
-- new constraint, and the application mints with a CSPRNG (crypto.randomInt),
-- which beats random() in SQL. ensurePayCode issues a fresh code the next time
-- each account's pay summary is read, so this self-heals on first visit.
--
-- CONSEQUENCE, deliberate: every pay code shared or printed before this stops
-- resolving. There is no aliasing of old codes -- an old code is not "changed",
-- it is gone, and /pay/c/{old} returns not-found rather than paying anyone.
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. Drop the 6-character constraint
-- ---------------------------------------------------------------------------

alter table public.pay_codes
  drop constraint if exists pay_codes_code_format;

-- ---------------------------------------------------------------------------
-- 2. Clear codes that cannot satisfy the new format
-- ---------------------------------------------------------------------------

delete from public.pay_codes
where code !~ '^[0-9]{9}$';

-- ---------------------------------------------------------------------------
-- 3. Enforce 9 digits, leading zeros allowed
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pay_codes_code_format'
  ) then
    alter table public.pay_codes
      add constraint pay_codes_code_format
      check (code ~ '^[0-9]{9}$');
  end if;
end
$$;

comment on table public.pay_codes is
  'One stable 9-digit pay code per account. Printed under the pay QR. Digits '
  'only so a code can never also be a valid @username.';

-- ---------------------------------------------------------------------------
-- 4. Post-condition: fail loudly rather than half-apply
-- ---------------------------------------------------------------------------

do $$
declare
  bad_rows integer;
begin
  if to_regclass('public.pay_codes') is null then
    raise exception 'pay_codes is missing after migration';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'pay_codes_code_format'
  ) then
    raise exception 'pay_codes_code_format constraint was not created';
  end if;

  select count(*) into bad_rows
  from public.pay_codes
  where code !~ '^[0-9]{9}$';

  if bad_rows > 0 then
    raise exception 'pay_codes still holds % rows that are not 9 digits', bad_rows;
  end if;
end
$$;
