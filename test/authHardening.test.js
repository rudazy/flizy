/**
 * Site auth hardening:
 *
 * - signup answers every address the same way and signs nobody in until the
 *   inbox code is entered, so it cannot be used to find out who has an account;
 * - changing a username takes the password, and the released name is held for
 *   its last owner for 90 days, so links to the old @name cannot pay a stranger;
 * - an unverified secondary email no longer blocks that address for its owner;
 * - linking GitHub, Discord or X tells the owner on chat and by email;
 * - the health detail token is compared over hashes.
 *
 * The routes build NextResponse and read cookies, so they are held by their
 * source; the pieces they delegate to are driven directly.
 *
 * Run: node --test test/authHardening.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const handler = (src) => src.slice(src.indexOf('export async function POST'));

let notice;
let bearer;

before(async () => {
  notice = await import('../web/lib/securityNotice.ts');
  bearer = await import('../web/lib/bearerSecret.ts');
});

describe('signup does not say which addresses have an account', () => {
  const SIGNUP = read('web/app/api/auth/signup/route.ts');
  const VERIFY = read('web/app/api/auth/signup/verify/route.ts');

  it('never signs anyone in', () => {
    assert.doesNotMatch(SIGNUP, /createSession/);
  });

  it('gives every accepted request the same answer', () => {
    const body = handler(SIGNUP);
    // Honeypot, verified owner, unverified account, insert race and new account.
    assert.equal((body.match(/return codeSent\(/g) || []).length, 5);
    assert.doesNotMatch(body, /already has an account/);
  });

  it('tells a verified owner by email and changes nothing on their account', () => {
    const body = handler(SIGNUP);
    const verified = body.indexOf('if (existing?.email_verified_at) {');
    const mail = body.indexOf('signupAttemptMail(siteOrigin(), new Date())', verified);
    const unverified = body.indexOf('if (existing) {', verified);
    assert.ok(verified > 0 && mail > verified && unverified > mail);
    assert.doesNotMatch(body.slice(verified, unverified), /\.update\(/);
  });

  it('never writes a password to an existing account: a re-signup password waits on the code', () => {
    const body = handler(SIGNUP);
    const existingBranch = body.slice(body.indexOf('if (existing) {'), body.indexOf('const inserted = await insertAccount('));
    assert.doesNotMatch(existingBranch, /\.update\(/);
    assert.match(existingBranch, /sendSignupCode\(existing\.id, email, password_hash\)/);
    assert.doesNotMatch(body, /password_hash, locale/);
    assert.match(SIGNUP, /issueEmailVerificationCode\(\{ accountId, email, purpose: 'primary', pendingPasswordHash \}\)/);
  });

  it('a replaced code drops the password it was holding', () => {
    assert.match(
      read('web/lib/emailVerify.ts'),
      /\.update\(\{ consumed_at: new Date\(\)\.toISOString\(\), pending_password_hash: null \}\)/
    );
  });

  it('pays for one password hash on every branch', () => {
    const body = handler(SIGNUP);
    assert.ok(body.indexOf('hashPassword(password)') < body.indexOf("from('accounts')"));
  });

  it('verify proves the inbox before any session, and signs older sessions out', () => {
    const body = handler(VERIFY);
    const consume = body.indexOf('consumeEmailVerificationCode(');
    const revoke = body.indexOf('await revokeAllSessions(account.id);');
    const create = body.indexOf('await createSession(account.id);');
    assert.ok(consume > 0 && revoke > consume && create > revoke);
  });

  it('verify answers an unknown, a verified and a wrong code the same way', () => {
    const body = handler(VERIFY);
    assert.match(body, /if \(!account \|\| account\.email_verified_at\) \{\s*return NextResponse\.json\(\{ error: WRONG \}/);
    assert.match(body, /\{ error: tooMany \? consumed\.error : WRONG \}/);
  });

  it('the form asks for the code and sends it to verify', () => {
    const form = read('web/app/signup/SignupForm.tsx');
    assert.match(form, /fetch\('\/api\/auth\/signup\/verify'/);
    assert.match(form, /body: JSON\.stringify\(\{ email, code \}\)/);
  });

  it('the owner mail says nothing changed and where to sign in', () => {
    const mail = notice.signupAttemptMail('https://flizy.test', new Date('2026-10-16T09:00:00Z'));
    assert.match(mail.text, /nothing was created and nothing on your account changed/);
    assert.match(mail.text, /https:\/\/flizy\.test\/login/);
  });
});

describe('usernames', () => {
  const USERNAME = read('web/app/api/account/username/route.ts');
  const PROFILE = read('web/app/api/account/profile/route.ts');
  const MIGRATION = read('supabase/migrations/20261016110000_username_holds.sql');

  it('a change takes the password before anything is written', () => {
    const gate = USERNAME.indexOf("requirePassword(supabase, accountId, password, 'change your username')");
    assert.ok(gate > 0);
    assert.ok(USERNAME.indexOf('if (current.username) {') < gate);
    assert.ok(USERNAME.indexOf('password.length > 256') < gate);
    assert.ok(gate < USERNAME.indexOf('.update({ username: check.username'));
  });

  it('the profile route sets the first name only', () => {
    assert.match(PROFILE, /if \(current\.username\) \{\s*return NextResponse\.json\(\s*\{ error: 'Change your username from Account, with your password\.' \}/);
  });

  it('a held name reads as unavailable in both routes', () => {
    for (const src of [USERNAME, PROFILE]) assert.match(src, /code === 'FZ003'/);
  });

  it('the trigger holds the released name for 90 days for its last owner', () => {
    assert.match(MIGRATION, /before insert or update of username\s+on public\.accounts/);
    assert.match(MIGRATION, /using errcode = 'FZ003'/);
    assert.match(MIGRATION, /h\.held_until > now\(\)\s+and h\.account_id <> new\.id/);
    assert.match(MIGRATION, /now\(\) \+ interval '90 days'/);
  });

  it('the holds table is locked to the service role', () => {
    assert.match(MIGRATION, /alter table public\.username_holds enable row level security;/);
    assert.match(MIGRATION, /revoke all on table public\.username_holds from public, anon, authenticated;/);
    assert.match(MIGRATION, /revoke all on function public\.accounts_hold_released_username\(\) from public, anon, authenticated;/);
    assert.match(MIGRATION, /set search_path = public, pg_temp/);
  });
});

describe('secondary emails', () => {
  const MIGRATION = read('supabase/migrations/20261016100000_account_emails_verified_unique.sql');

  it('only verified rows are unique across accounts', () => {
    assert.match(MIGRATION, /create unique index if not exists account_emails_verified_email_unique\s+on public\.account_emails \(lower\(email\)\)\s+where verified_at is not null;/);
    assert.match(MIGRATION, /drop index if exists public\.account_emails_email_unique;/);
    // Built before the old one goes, so the table always has a rule.
    assert.ok(MIGRATION.indexOf('create unique index') < MIGRATION.indexOf('drop index'));
  });

  it('verifying an address another account verified says so', () => {
    const src = read('web/lib/emailVerify.ts');
    assert.match(src, /if \(sErr\?\.code === '23505'\) \{\s*return \{\s*ok: false,\s*error: 'That email is already verified on another Flizy account\.'/);
  });

  it('adding one twice is about this account, not somebody else', () => {
    assert.match(read('web/app/api/account/emails/route.ts'), /error: 'That email is already on your account\.'/);
  });
});

describe('platform links are announced', () => {
  for (const platform of ['github', 'discord', 'x']) {
    it(`${platform}: only a new link, after it is made`, () => {
      const src = read(`web/app/api/auth/${platform}/callback/route.ts`);
      assert.match(src, /linked = bound\.outcome === BIND_OUTCOME\.LINKED;/);
      assert.match(src, new RegExp(`if \\(linked\\) await announcePlatformLink\\(accountId, '${platform}', identity\\.login \\|\\| null\\);`));
    });
  }

  it('the mail names the platform and how to undo it', () => {
    const mail = notice.platformLinkedMail('https://flizy.test', 'github', 'octo\ncat', new Date());
    assert.equal(mail.subject, 'GitHub was linked to your Flizy account');
    assert.match(mail.text, /^GitHub \(@octocat\) was linked/);
    assert.match(mail.text, /dashboard\/account\?s=platforms/);
  });
});

describe('the health detail token', () => {
  it('is compared over hashes', () => {
    const src = read('web/app/api/health/schema/route.ts');
    assert.match(src, /return secretMatches\(offered, process\.env\.SCHEMA_HEALTH_TOKEN\);/);
    assert.doesNotMatch(src, /a\.length !== b\.length/);
  });

  it('secretMatches holds for any length and refuses an unset secret', () => {
    assert.equal(bearer.secretMatches('token-123', 'token-123'), true);
    assert.equal(bearer.secretMatches('token-12', 'token-123'), false);
    assert.equal(bearer.secretMatches('x'.repeat(500), 'token-123'), false);
    assert.equal(bearer.secretMatches('', ''), false);
    assert.equal(bearer.secretMatches('anything', undefined), false);
  });
});

describe('a re-signup password waits on its code', () => {
  const EMAIL = 'owner@example.com';
  const OLD = 'hash-of-the-password-the-owner-set';
  const NEW = 'hash-of-the-password-typed-at-re-signup';
  let verify;
  let fake;

  before(async () => {
    verify = await import('../web/lib/emailVerify.ts');
  });

  function seed(code) {
    const { createFakeSupabase } = require('./helpers/fakeSupabase');
    fake = createFakeSupabase({
      accounts: [{ id: 'acc-1', email: EMAIL, email_verified_at: null, password_hash: OLD }],
      email_verifications: [
        {
          id: 'ev-1',
          account_id: 'acc-1',
          email: EMAIL,
          purpose: 'primary',
          code_hash: verify.hashEmailCode(code),
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          attempts: 0,
          consumed_at: null,
          pending_password_hash: NEW,
          created_at: new Date().toISOString(),
        },
      ],
      invite_events: [],
    });
  }

  const consume = (code) =>
    verify.consumeEmailVerificationCode({
      accountId: 'acc-1',
      email: EMAIL,
      purpose: 'primary',
      code,
      supabase: fake.client,
    });

  it('a wrong code leaves the old password and keeps the new one waiting', async () => {
    seed('123456');
    const r = await consume('654321');
    assert.equal(r.ok, false);
    assert.equal(fake.db.tables.accounts[0].password_hash, OLD);
    assert.equal(fake.db.tables.email_verifications[0].pending_password_hash, NEW);
  });

  it('the right code hands the new password to the caller and clears it from the row', async () => {
    seed('123456');
    const r = await consume('123456');
    assert.equal(r.ok, true);
    assert.equal(r.pendingPasswordHash, NEW);
    assert.equal(fake.db.tables.email_verifications[0].pending_password_hash, null);
    // Consuming does not set it: only the signup verify route does.
    assert.equal(fake.db.tables.accounts[0].password_hash, OLD);
  });
});

describe('a re-signup that takes an account over hands it over clean', () => {
  const VERIFY = read('web/app/api/auth/signup/verify/route.ts');
  let reset;

  before(async () => {
    reset = await import('../web/lib/accountReset.ts');
  });

  function seeded() {
    const { createFakeSupabase } = require('./helpers/fakeSupabase');
    return createFakeSupabase({
      accounts: [
        { id: 'acc-1', email: 'owner@example.com', password_hash: 'old', unlock_pin_hash: 'pin-of-earlier-holder' },
        { id: 'acc-2', email: 'other@example.com', password_hash: 'x', unlock_pin_hash: 'other-pin' },
      ],
      channel_identities: [
        { id: 'c1', account_id: 'acc-1', channel: 'whatsapp', external_id: '2348011112222' },
        { id: 'c2', account_id: 'acc-1', channel: 'telegram', external_id: '5566778899' },
        { id: 'c3', account_id: 'acc-1', channel: 'github', external_id: '42', display_handle: 'octo' },
        { id: 'c4', account_id: 'acc-2', channel: 'telegram', external_id: '1122334455' },
      ],
      sessions: [
        { account_id: 'acc-1', channel: 'telegram', external_id: '5566778899', is_locked: false },
        { account_id: 'acc-2', channel: 'telegram', external_id: '1122334455', is_locked: false },
      ],
      trusted_addresses: [
        { id: 't1', account_id: 'acc-1', address: '0x1111111111111111111111111111111111111111', status: 'active' },
        { id: 't2', account_id: 'acc-1', address: '0x2222222222222222222222222222222222222222', status: 'pending' },
        { id: 't3', account_id: 'acc-2', address: '0x3333333333333333333333333333333333333333', status: 'active' },
      ],
      trusted_add_tickets: [
        { id: 'k1', account_id: 'acc-1', code: 'ABC' },
        { id: 'k2', account_id: 'acc-2', code: 'DEF' },
      ],
      identity_events: [],
    });
  }

  it('sets the new password, clears the PIN, unlinks everything and drops chat unlocks', async () => {
    const fake = seeded();
    const out = await reset.resetForNewOwner(fake.client, 'acc-1', 'new-hash');
    const acc = fake.db.tables.accounts.find((a) => a.id === 'acc-1');
    assert.equal(acc.password_hash, 'new-hash');
    assert.equal(acc.unlock_pin_hash, null);
    assert.deepEqual(out.unlinked.sort(), ['github', 'telegram', 'whatsapp']);
    assert.deepEqual(fake.db.tables.channel_identities.map((i) => i.id), ['c4']);
    assert.deepEqual(fake.db.tables.sessions.map((s) => s.account_id), ['acc-2']);
    // Each unlink is on the identity audit trail.
    assert.equal(fake.db.tables.identity_events.filter((e) => e.event_type === 'UNLINKED').length, 3);
  });

  it('empties the trusted list, held addresses and chat adds included', async () => {
    const fake = seeded();
    const out = await reset.resetForNewOwner(fake.client, 'acc-1', 'new-hash');
    assert.equal(out.trustedRemoved, 2);
    assert.deepEqual(fake.db.tables.trusted_addresses.map((t) => t.id), ['t3']);
    assert.deepEqual(fake.db.tables.trusted_add_tickets.map((t) => t.id), ['k2']);
  });

  it('leaves every other account alone', async () => {
    const fake = seeded();
    await reset.resetForNewOwner(fake.client, 'acc-1', 'new-hash');
    const other = fake.db.tables.accounts.find((a) => a.id === 'acc-2');
    assert.equal(other.unlock_pin_hash, 'other-pin');
    assert.equal(other.password_hash, 'x');
    assert.equal(fake.db.tables.trusted_addresses.filter((t) => t.account_id === 'acc-2').length, 1);
  });

  it('covers every channel an identity can be linked on', () => {
    assert.deepEqual([...reset.RESET_CHANNELS].sort(), ['discord', 'github', 'telegram', 'whatsapp', 'x']);
  });

  it('runs only for a re-signup, after the code, before the session, then mails the address', () => {
    const body = handler(VERIFY);
    const consume = body.indexOf('consumeEmailVerificationCode(');
    const gate = body.indexOf('if (consumed.pendingPasswordHash) {');
    const doReset = body.indexOf('resetForNewOwner(supabase, account.id, consumed.pendingPasswordHash)');
    const revoke = body.indexOf('await revokeAllSessions(account.id);');
    const create = body.indexOf('await createSession(account.id);');
    const mail = body.indexOf('accountResetMail(siteOrigin(), reset.unlinked, reset.trustedRemoved, new Date())');
    assert.ok(consume > 0 && gate > consume && doReset > gate && revoke > doReset && create > revoke && mail > create);
    assert.doesNotMatch(body, /update\(\{ password_hash: consumed\.pendingPasswordHash \}\)/);
  });

  it('a failed reset undoes the verification, so a fresh signup redoes the handover', () => {
    const body = handler(VERIFY);
    const failure = body.slice(body.indexOf('} catch (err) {', body.indexOf('resetForNewOwner(')));
    assert.match(failure, /^\} catch \(err\) \{[\s\S]*?\.update\(\{ email_verified_at: null \}\)\.eq\('id', account\.id\);\s*return NextResponse\.json\(\{ error: 'Could not finish\. Sign up again for a new code\.' \}, \{ status: 500 \}\);/);
  });

  it('the mail says what was reset and what to do next', () => {
    const mail = notice.accountResetMail('https://flizy.test', ['whatsapp', 'github'], 2, new Date('2026-10-15T10:00:00Z'));
    assert.equal(mail.subject, 'Your Flizy account was reset when you verified your email');
    assert.match(mail.text, /the unlock PIN was cleared/);
    assert.match(mail.text, /these were unlinked: WhatsApp, GitHub/);
    assert.match(mail.text, /the trusted list was emptied \(2 addresses removed\)/);
    assert.match(mail.text, /every other signed-in browser was signed out/);
    assert.match(mail.text, /Add the wallets you send to back to your trusted list/);
    assert.match(mail.text, /Set a new unlock PIN: https:\/\/flizy\.test\/dashboard\/account/);
    assert.match(mail.text, /Link your chat apps and platforms again: https:\/\/flizy\.test\/dashboard\/account\?s=chat/);
    const empty = notice.accountResetMail('https://flizy.test', [], 0, new Date()).text;
    assert.match(empty, /nothing was linked/);
    assert.match(empty, /the trusted list was already empty/);
  });
});
