-- DESTRUCTIVE, MANUAL ONLY. NOT A MIGRATION. DO NOT AUTOMATE.
--
-- Truncates every user-facing table: accounts, users, chat identities, claims,
-- payment requests, transfers, sessions, link codes, trusted addresses and
-- contacts. Everyone loses their account and has to register again. On-chain
-- funds are not moved, so anything still sitting in an agent wallet stops being
-- reachable through the product once the account row it derives from is gone.
--
-- This file used to sit in supabase/migrations/ with a timestamp prefix, where a
-- `supabase db push` or any "apply everything in order" loop would have run it
-- against whatever database was configured, production included. It lives here
-- so it can never sort into a migration run.
--
-- Run it only by hand, only against a testnet database you mean to reset, and
-- only after checking which database you are connected to.
--
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
