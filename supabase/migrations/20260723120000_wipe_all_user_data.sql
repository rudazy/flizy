-- Full reset: wipe all Flizy app data so everyone re-registers.
-- Run once when intentionally resetting testnet users.
-- Does NOT drop schema. Only deletes rows.

begin;

truncate table public.payment_requests restart identity cascade;
truncate table public.claims restart identity cascade;
truncate table public.sessions restart identity cascade;
truncate table public.link_codes restart identity cascade;
truncate table public.trusted_addresses restart identity cascade;
truncate table public.whatsapp_identities restart identity cascade;
truncate table public.transfers restart identity cascade;
truncate table public.contacts restart identity cascade;
truncate table public.users restart identity cascade;
truncate table public.accounts restart identity cascade;

commit;
