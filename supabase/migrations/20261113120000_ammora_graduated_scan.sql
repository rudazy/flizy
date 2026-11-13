-- Ammora graduated pools: a second discovery cursor.
--
-- When an Ammora launch fills its curve it migrates to a concentrated or
-- compounding pool made by the pinned deployment's own factories. The bot now
-- discovers those pools too (lib/ammora/inventory.js) and stores them in
-- ammora_pools next to the launch's curve, so a graduated launch stays
-- tradable through the pinned aggregation router.
--
--   ammora_scan_state.graduated_scanned_to_block
--                      How far the graduated-pool scan has reached. Null means
--                      it has not started, and it starts from the pinned
--                      factory's start block. Kept apart from scanned_to_block
--                      because the curve scan is already at the chain head.
--
-- ammora_pools already accepts the 'concentrated' and 'compounding' models.
--
-- Idempotent: safe to run twice.

alter table public.ammora_scan_state
  add column if not exists graduated_scanned_to_block bigint;

comment on column public.ammora_scan_state.graduated_scanned_to_block is
  'Highest block the Ammora graduated-pool scan has reached. Null: not started.';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ammora_scan_state'
      and column_name = 'graduated_scanned_to_block'
  ) then
    raise exception 'ammora_scan_state.graduated_scanned_to_block is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'ammora_pools_model_check'
      and pg_get_constraintdef(oid) like '%concentrated%'
      and pg_get_constraintdef(oid) like '%compounding%'
  ) then
    raise exception 'ammora_pools_model_check does not accept graduated pools';
  end if;
end $$;
