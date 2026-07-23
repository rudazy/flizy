-- Phone on whatsapp_identities is the join key for claims/requests (LID stays identity).
-- Column wa_phone_e164 already exists; add lookup index and store digits-only form.

create index if not exists whatsapp_identities_phone_idx
  on public.whatsapp_identities (wa_phone_e164)
  where wa_phone_e164 is not null;

comment on column public.whatsapp_identities.wa_phone_e164 is
  'Normalized phone digits (country code, no plus). Join key for claims/requests. LID remains wa_sender_id.';
