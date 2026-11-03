-- Swap and Sync events of the listed Flizy pairs (FLZ and the listed tokens).
--
-- One row per log, keyed by chain, transaction hash and log index, so the
-- poller, the backfill and the Nodit webhook can all write the same log and
-- only the first write lands. Every row is read from the chain by the server
-- (web/lib/pairEvents.ts); a webhook only names transactions to look at.
--
-- A Swap row carries the four amounts. A Sync row carries the reserves after
-- the trade, which is the pool price the Explore sparkline steps to. Amounts
-- and reserves are base-unit integers kept as text.
--
-- pair_index_cursors records, per pair, the highest block below which every
-- block has been read, so the poller resumes where it stopped.
--
-- Service role only. Idempotent. A partial apply fails the post-condition.

create table if not exists public.pair_events (
  chain_id integer not null,
  pair text not null,
  tx_hash text not null,
  log_index integer not null,
  block_number bigint not null,
  block_time timestamptz not null,
  kind text not null,
  amount0_in text,
  amount1_in text,
  amount0_out text,
  amount1_out text,
  reserve0 text,
  reserve1 text,
  created_at timestamptz not null default now(),
  primary key (chain_id, tx_hash, log_index),
  constraint pair_events_pair_check check (pair ~ '^0x[0-9a-f]{40}$'),
  constraint pair_events_tx_hash_check check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  constraint pair_events_log_index_check check (log_index >= 0),
  constraint pair_events_block_check check (block_number >= 0),
  constraint pair_events_kind_check check (kind in ('swap', 'sync')),
  constraint pair_events_swap_amounts_check check (
    kind <> 'swap' or (
      amount0_in ~ '^[0-9]+$' and amount1_in ~ '^[0-9]+$'
      and amount0_out ~ '^[0-9]+$' and amount1_out ~ '^[0-9]+$'
    )
  ),
  constraint pair_events_sync_reserves_check check (
    kind <> 'sync' or (reserve0 ~ '^[0-9]+$' and reserve1 ~ '^[0-9]+$')
  )
);

create index if not exists pair_events_pair_kind_time_idx
  on public.pair_events (chain_id, pair, kind, block_time desc);

alter table public.pair_events enable row level security;
revoke all on table public.pair_events from anon, authenticated;
grant all on table public.pair_events to service_role;

comment on table public.pair_events is
  'Swap and Sync logs of the listed Flizy pairs, read from the chain by the server. Unique by chain, tx hash and log index. Service role only.';

create table if not exists public.pair_index_cursors (
  chain_id integer not null,
  pair text not null,
  indexed_to bigint not null,
  updated_at timestamptz not null default now(),
  primary key (chain_id, pair),
  constraint pair_index_cursors_pair_check check (pair ~ '^0x[0-9a-f]{40}$'),
  constraint pair_index_cursors_block_check check (indexed_to >= 0)
);

alter table public.pair_index_cursors enable row level security;
revoke all on table public.pair_index_cursors from anon, authenticated;
grant all on table public.pair_index_cursors to service_role;

comment on table public.pair_index_cursors is
  'Per listed pair, the highest block below which every Swap and Sync log has been read. Service role only.';

do $$
begin
  if to_regclass('public.pair_events') is null then
    raise exception 'public.pair_events is missing';
  end if;
  if to_regclass('public.pair_index_cursors') is null then
    raise exception 'public.pair_index_cursors is missing';
  end if;
  if to_regclass('public.pair_events_pair_kind_time_idx') is null then
    raise exception 'index pair_events_pair_kind_time_idx is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.pair_events'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.pair_index_cursors'::regclass) then
    raise exception 'row level security is off on pair_events or pair_index_cursors';
  end if;
  if has_table_privilege('anon', 'public.pair_events', 'select')
     or has_table_privilege('authenticated', 'public.pair_events', 'select')
     or has_table_privilege('anon', 'public.pair_index_cursors', 'select')
     or has_table_privilege('authenticated', 'public.pair_index_cursors', 'select') then
    raise exception 'pair_events or pair_index_cursors is readable by anon or authenticated';
  end if;
end;
$$;
