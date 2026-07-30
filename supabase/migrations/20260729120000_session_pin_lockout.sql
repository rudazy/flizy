-- Failed-PIN lockout state, per chat session.
--
-- flizy lock exists to protect somebody whose unlocked phone is in another
-- person's hands. Until now the unlock path had no attempt counter at all, so a
-- 4 digit PIN was 10,000 messages away from being guessed by exactly the
-- attacker the feature is designed to stop.
--
-- The counter lives on the session row, not in the bot process: one account can
-- be bound to WhatsApp and Telegram at once and both processes restart often,
-- so in-memory state would be a free reset. It is scoped the same way the lock
-- itself is, per (account_id, channel, external_id), so brute forcing the
-- WhatsApp session cannot block the Telegram one the owner still holds.
--
-- Cleared only by a correct secret, or by a password-authenticated PIN reset on
-- the site. That web path is the interlock that lets the ladder in
-- lib/session.js climb to 24 hours without stranding a legitimate user.
--
-- Additive only. No existing column changes.

alter table public.sessions
  add column if not exists failed_pin_attempts integer not null default 0;

alter table public.sessions
  add column if not exists pin_locked_until timestamptz;

comment on column public.sessions.failed_pin_attempts is
  'Consecutive wrong unlock secrets on this session. Reset to 0 by a correct secret or a password-authenticated PIN reset on the site. Never reset by an ordinary session write.';

comment on column public.sessions.pin_locked_until is
  'While in the future, unlock is refused without the secret being compared at all. Set on an escalating ladder by lib/session.js.';
