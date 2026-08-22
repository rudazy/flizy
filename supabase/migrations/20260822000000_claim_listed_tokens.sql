-- Identity claims for listed ERC-20 tokens (FLZ first).
-- amount_eth stays the human decimal amount (same as transfers.amount_eth).
-- asset is the listed symbol; token_address is null for native ETH.
--
-- Idempotent: safe to run twice.

alter table public.claims
  add column if not exists asset text not null default 'ETH';

alter table public.claims
  add column if not exists token_address text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'claims_asset_token_consistency'
  ) then
    alter table public.claims
      add constraint claims_asset_token_consistency
      check (
        (
          upper(asset) in ('ETH', 'NATIVE', 'ETHER')
          and token_address is null
        )
        or (
          upper(asset) not in ('ETH', 'NATIVE', 'ETHER')
          and token_address ~ '^0x[a-fA-F0-9]{40}$'
        )
      );
  end if;
end
$$;

comment on column public.claims.asset is
  'Listed symbol of the held asset. ETH is native; FLZ and later listed tokens are ERC-20.';
comment on column public.claims.token_address is
  'ERC-20 contract for non-native holds. Null for ETH.';

do $$
declare
  has_asset boolean;
  has_token boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'claims' and column_name = 'asset'
  ) into has_asset;
  if has_asset is not true then
    raise exception 'claims.asset is missing';
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'claims' and column_name = 'token_address'
  ) into has_token;
  if has_token is not true then
    raise exception 'claims.token_address is missing';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'claims_asset_token_consistency'
  ) then
    raise exception 'claims_asset_token_consistency is missing';
  end if;
end
$$;
