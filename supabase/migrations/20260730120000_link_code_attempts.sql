-- Attempt limiting for `flizy link CODE`, per chat identity.
--
-- A link code binds a chat channel to an account, so guessing one attaches the
-- guesser's own WhatsApp or Telegram to somebody else's money. Until now there
-- was no attempt counter on that command at all, and the code carried 32 bits.
-- Codes are now 50 bits (lib/linkCode.js) and this table is the second layer.
--
-- Keyed on (channel, external_id), not on account_id like the failed-PIN counter
-- in sessions. A link attempt is the one case where the account is unknown by
-- definition: whoever is guessing is not linked to anything yet. Scoping it to
-- the chat identity also means one guesser cannot lock out anybody else.
--
-- The ladder is shared code, not a copy: lib/lockoutLadder.js drives both this
-- and the PIN lockout, so the steps stay identical (5th wrong = 1 min, 6th =
-- 5 min, 7th = 15 min, 8th = 1 h, 9th and after = 24 h). The way back in without
-- waiting is generating a fresh code on the site, which a user who mistyped
-- would do anyway.
--
-- Additive only. Creates one table, changes nothing existing.

create table if not exists public.link_code_attempts (
  channel text not null,
  external_id text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint link_code_attempts_pkey primary key (channel, external_id)
);

create index if not exists link_code_attempts_locked_idx
  on public.link_code_attempts (locked_until);

-- Service role only, same posture as the other bot-owned tables: RLS on with no
-- policies, so the anon key can never read or write it.
alter table public.link_code_attempts enable row level security;

comment on table public.link_code_attempts is
  'Wrong link-code counter per chat identity. Escalating lockout driven by lib/lockoutLadder.js, the same ladder as the failed-PIN lockout on sessions.';

comment on column public.link_code_attempts.failed_attempts is
  'Consecutive link codes that did not exist. Reset to 0 only by a code that is accepted. An expired code is not counted: it was really issued to that account, so a slow legitimate user is never pushed up the ladder.';

comment on column public.link_code_attempts.locked_until is
  'While in the future, `link CODE` is refused before the code is looked up at all, so a locked-out guesser learns nothing about whether their guess existed.';
