-- Identity NFT claims: one ERC-721 token id on the same claims row as ETH/FLZ.
-- amount_eth stays the human decimal (1 for an NFT hold).
-- token_address is the collection; nft_token_id is the ERC-721 id.
--
-- Idempotent: safe to run twice.

alter table public.claims
  add column if not exists nft_token_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'claims_nft_token_id_shape'
  ) then
    alter table public.claims
      add constraint claims_nft_token_id_shape
      check (
        nft_token_id is null
        or nft_token_id ~ '^[0-9]+$'
      );
  end if;
end
$$;

comment on column public.claims.nft_token_id is
  'ERC-721 token id when the hold is an NFT. Null for ETH and ERC-20 holds.';

do $$
declare
  has_col boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'claims' and column_name = 'nft_token_id'
  ) into has_col;
  if has_col is not true then
    raise exception 'claims.nft_token_id is missing';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'claims_nft_token_id_shape'
  ) then
    raise exception 'claims_nft_token_id_shape is missing';
  end if;
end
$$;
