-- Let marketplace actions that move no ETH be logged.
--
-- transfers.amount_eth has been "> 0" since the table was created: every row
-- was a payment. NFT marketplace actions are logged here too (kind
-- 'nft_market', web/app/api/market/[action]/route.ts and
-- lib/engine/executeAcceptOffer.js), and listing, cancelling, accepting an
-- offer, setting a royalty and withdrawing send no ETH, so their rows carry 0.
-- The old check rejected them, and the site answered a listing with a generic
-- error before anything reached the chain.
--
-- Zero is allowed for 'nft_market' rows only. Every other kind keeps the
-- original rule, so a zero-value payment row is still impossible.
--
-- Re-running is safe.

alter table public.transfers drop constraint if exists transfers_amount_eth_check;
alter table public.transfers
  add constraint transfers_amount_eth_check
  check (amount_eth > 0 or (kind = 'nft_market' and amount_eth = 0));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.transfers'::regclass
      and conname = 'transfers_amount_eth_check'
      and pg_get_constraintdef(oid) like '%nft_market%'
  ) then
    raise exception 'transfers_amount_eth_check does not allow nft_market rows';
  end if;

  -- An amount check under another name would still reject the zero rows.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.transfers'::regclass
      and contype = 'c'
      and conname <> 'transfers_amount_eth_check'
      and pg_get_constraintdef(oid) like '%amount_eth%'
  ) then
    raise exception 'another check on transfers.amount_eth is still in place';
  end if;
end;
$$;
