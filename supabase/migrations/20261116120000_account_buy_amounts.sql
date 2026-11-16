-- Quick buy amounts.
--
-- When a token contract is pasted in chat, Flizy offers a few ETH amounts to
-- buy it with (lib/buyAmounts.js): buttons on Telegram, a list on WhatsApp.
-- Each account can set its own with Edit.
--
--   accounts.buy_amounts_eth   1 to 5 ETH amounts as text, each above 0 with
--                              at most 3 whole digits and 6 decimals. null
--                              means the app defaults (DEFAULT_BUY_AMOUNTS).
--                              The app also caps each at 100 ETH and reads
--                              any malformed value as the defaults.
--
-- Idempotent: safe to run twice. A partial apply fails the post-condition.

alter table public.accounts
  add column if not exists buy_amounts_eth text[];

alter table public.accounts
  drop constraint if exists accounts_buy_amounts_eth_check;
alter table public.accounts
  add constraint accounts_buy_amounts_eth_check
  check (
    buy_amounts_eth is null
    or (
      cardinality(buy_amounts_eth) between 1 and 5
      and array_position(buy_amounts_eth, null) is null
      and array_to_string(buy_amounts_eth, ',') ~ '^[0-9]{1,3}(\.[0-9]{1,6})?(,[0-9]{1,3}(\.[0-9]{1,6})?){0,4}$'
    )
  );

comment on column public.accounts.buy_amounts_eth is
  'Quick ETH amounts offered when a token contract is pasted in chat. null = app defaults.';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'accounts' and column_name = 'buy_amounts_eth'
  ) then
    raise exception 'accounts.buy_amounts_eth is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounts_buy_amounts_eth_check') then
    raise exception 'accounts_buy_amounts_eth_check is missing';
  end if;
end
$$;
