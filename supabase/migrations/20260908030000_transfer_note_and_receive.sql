-- Receiving a payment leaves a record, and that record says what it was for.
--
-- Two gaps, one migration.
--
-- WHAT IT WAS FOR. `pay 0.01 for coffee` already parses, and the reason reaches
-- the confirm screen as "For: coffee". It was never stored, so the moment the
-- plan executed the reason was gone -- from the sender's history, from any
-- receipt, and from the person being paid. `note` keeps it.
--
-- THE RECEIVE SIDE. Every transfers row in production is direction 'out': 290
-- of 290 when this was written. A row is created by the sender, keyed to the
-- sender, and nothing else. So the person receiving a direct send had no
-- history entry and no notification -- money simply appeared in their balance.
-- Meanwhile 16 of 267 confirmed transfers already point at a Flizy wallet, so
-- the records exist and were merely unreachable from the other end.
--
-- NO SECOND ROW, DELIBERATELY. The obvious fix is to write the receiver their
-- own transfers row, and that is the one thing this must not do: it would store
-- one payment twice and let the two copies disagree about amount, status or
-- hash. Same argument as the bills table and the pot balance. The receiver's
-- history reads the sender's row from the other side, matching on to_address,
-- which is why the only structural change here is an index that makes that
-- lookup cheap.
--
-- Addresses are stored checksummed (mixed case), so the index and every query
-- against it go through lower().
--
-- Idempotent: safe to run twice.

-- ---------------------------------------------------------------------------
-- 1. What the payment was for
-- ---------------------------------------------------------------------------

alter table public.transfers
  add column if not exists note text;

-- ---------------------------------------------------------------------------
-- 2. Finding what you were paid
-- ---------------------------------------------------------------------------

-- History already looks up a person's own rows by account_id and by phone. This
-- is the third way in: rows addressed TO their wallet. Without the index that
-- is a sequential scan of every transfer the system has ever recorded, on a
-- path a user hits by typing "history".
create index if not exists transfers_to_address_created_idx
  on public.transfers (lower(to_address), created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Post-condition
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transfers'
      and column_name = 'note'
  ) then
    raise exception 'transfers.note was not created';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'transfers_to_address_created_idx'
  ) then
    raise exception 'transfers_to_address_created_idx was not created';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Documentation
-- ---------------------------------------------------------------------------

comment on column public.transfers.note is
  'What the payment was for, as the sender typed it ("pay 0.01 for coffee"). Shown to both sides in history and to the recipient when the money lands. Attacker-controlled text: render through displaySafeLabel.';
