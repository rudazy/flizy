-- Claim escrow fields: hold until recipient links WhatsApp; sender can cancel anytime while pending

alter table public.claims
  add column if not exists from_wa_sender text,
  add column if not exists hold_tx_hash text,
  add column if not exists refund_tx_hash text,
  add column if not exists claim_tx_hash text;

create index if not exists claims_from_account_status_idx
  on public.claims (from_account_id, status, created_at desc);

create index if not exists claims_to_wa_hint_status_idx
  on public.claims (to_wa_hint, status);

create index if not exists claims_from_wa_sender_idx
  on public.claims (from_wa_sender);

comment on column public.claims.to_wa_hint is 'Normalized WhatsApp/phone digits the claim is reserved for. Pays out only after that WA links.';
comment on column public.claims.hold_tx_hash is 'Escrow: sender agent wallet → ops hold';
comment on column public.claims.refund_tx_hash is 'Cancel: ops hold → sender agent wallet';
comment on column public.claims.claim_tx_hash is 'Payout: ops hold → recipient agent wallet';
