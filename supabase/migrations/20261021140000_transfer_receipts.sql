-- A payment can be shared as a receipt page, /r/{token}.
--
-- A receipt is private until one of the two people in it shares it. Sharing
-- gives the transfer a random token, and the page is found by that token only:
-- a transfer id never opens a receipt, so nobody can walk the table by
-- guessing ids. The token is 22 characters of base64url (128 random bits),
-- made by the app, and stays the same once made so a link already sent keeps
-- working.
--
-- What the page shows is decided by the app, not stored here: the amount, the
-- asset, when, the network and the transaction. Each person is named by
-- @username only if they chose to be named on Scan.
--
-- Service role only, like every table in public. Idempotent: safe to run twice.

alter table public.transfers
  add column if not exists receipt_token text;

alter table public.transfers drop constraint if exists transfers_receipt_token_format;
alter table public.transfers
  add constraint transfers_receipt_token_format
  check (receipt_token is null or receipt_token ~ '^[A-Za-z0-9_-]{22}$');

create unique index if not exists transfers_receipt_token_idx
  on public.transfers (receipt_token)
  where receipt_token is not null;

comment on column public.transfers.receipt_token is
  'Random token behind the shared receipt page /r/{token}. Null until a party shares it. Never derived from the id.';

-- ---------------------------------------------------------------------------
-- Post-conditions: a partial apply fails here instead of half-landing.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'transfers' and column_name = 'receipt_token'
  ) then
    raise exception 'transfers.receipt_token is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transfers_receipt_token_format') then
    raise exception 'transfers_receipt_token_format is missing';
  end if;
  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'transfers_receipt_token_idx'
  ) then
    raise exception 'transfers_receipt_token_idx is missing';
  end if;
end
$$;
