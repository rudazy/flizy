/**
 * "People who know my email can find me" (accounts.findable_by_email,
 * migration 20261119120000).
 *
 * Covers: the lookup only names an account whose address is VERIFIED there,
 * that turned the setting on, and that has a username, case-blind and with
 * wildcards taken literally; an ambiguous address names nobody. In chat, an
 * opted-in address gets "send now or hold"; every other address goes straight
 * to the claim, unchanged. Send now pays the checked account by id, never by a
 * name. After a hold, an email claim says the recipient is on Flizy only when
 * they opted in, and otherwise reads like a send to an address not on Flizy.
 * The setting's route checks origin and session, and takes a boolean only.
 *
 * Run: node --test test/emailFindable.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t) });
const { findOptedInAccountByEmail } = require('../lib/accountEmails');

const VERIFIED = '2026-11-01T00:00:00.000Z';
const acct = (over = {}) => ({ id: 'acc-1', email: 'bob@x.com', email_verified_at: VERIFIED, username: 'bob', findable_by_email: true, ...over });

describe('findOptedInAccountByEmail', () => {
  beforeEach(() => {
    fake = createFakeSupabase({ accounts: [], account_emails: [] });
  });

  it('names a verified, opted-in account with a username', async () => {
    fake.db.tables.accounts.push(acct());
    assert.deepEqual(await findOptedInAccountByEmail('bob@x.com'), { id: 'acc-1', username: 'bob' });
  });

  it('matches the address whatever its case', async () => {
    fake.db.tables.accounts.push(acct());
    assert.deepEqual(await findOptedInAccountByEmail('BoB@X.com'), { id: 'acc-1', username: 'bob' });
  });

  it('names nobody while the setting is off, which is the default', async () => {
    fake.db.tables.accounts.push(acct({ findable_by_email: false }));
    assert.equal(await findOptedInAccountByEmail('bob@x.com'), null);
    fake.db.tables.accounts[0].findable_by_email = undefined;
    assert.equal(await findOptedInAccountByEmail('bob@x.com'), null);
  });

  it('never trusts an unverified registration email, so an address cannot be squatted', async () => {
    fake.db.tables.accounts.push(acct({ email_verified_at: null }));
    assert.equal(await findOptedInAccountByEmail('bob@x.com'), null);
  });

  it('accepts a verified secondary email, and not an unverified one', async () => {
    fake.db.tables.accounts.push(acct({ email: 'main@y.com' }));
    fake.db.tables.account_emails.push({ account_id: 'acc-1', email: 'bob@x.com', verified_at: null });
    assert.equal(await findOptedInAccountByEmail('bob@x.com'), null);
    fake.db.tables.account_emails[0].verified_at = VERIFIED;
    assert.deepEqual(await findOptedInAccountByEmail('bob@x.com'), { id: 'acc-1', username: 'bob' });
  });

  it('names nobody without a username to show', async () => {
    fake.db.tables.accounts.push(acct({ username: null }));
    assert.equal(await findOptedInAccountByEmail('bob@x.com'), null);
    fake.db.tables.accounts[0].username = '   ';
    assert.equal(await findOptedInAccountByEmail('bob@x.com'), null);
  });

  it('names nobody when two accounts hold the address verified', async () => {
    fake.db.tables.accounts.push(acct());
    fake.db.tables.accounts.push(acct({ id: 'acc-2', email: 'other@y.com', username: 'other' }));
    fake.db.tables.account_emails.push({ account_id: 'acc-2', email: 'bob@x.com', verified_at: VERIFIED });
    assert.equal(await findOptedInAccountByEmail('bob@x.com'), null);
  });

  it('treats _ and % in the address as plain characters', async () => {
    fake.db.tables.accounts.push(acct({ email: 'boba@x.com' }));
    assert.equal(await findOptedInAccountByEmail('bob_@x.com'), null);
    assert.equal(await findOptedInAccountByEmail('bo%@x.com'), null);
  });

  it('names nobody for a malformed address', async () => {
    fake.db.tables.accounts.push(acct());
    assert.equal(await findOptedInAccountByEmail('not an email'), null);
    assert.equal(await findOptedInAccountByEmail(''), null);
  });
});

describe('chat', () => {
  const claims = read('lib/handlers/claims.js');
  const router = read('lib/router.js');
  const handler = claims.slice(claims.indexOf('async function handleSendEmailClaim('), claims.indexOf('async function tguserCapRefusal('));

  it('asks "send now or hold" only for an opted-in account that is not the sender', () => {
    assert.match(handler, /if \(!opts\.holdOnly\) \{/);
    assert.match(handler, /found = await findOptedInAccountByEmail\(recipient\.email\);/);
    assert.match(handler, /if \(found && found\.id !== siteAcc\.id\) \{\s+await askEmailSendChoice\(/);
    // The question comes after the own-email refusal, so it never names the sender to themself.
    assert.ok(handler.indexOf("'That email is on your own Flizy account.'") < handler.indexOf('askEmailSendChoice('));
  });

  it('a failed lookup falls through to the claim, unchanged', () => {
    assert.match(handler, /\} catch \(err\) \{\s+console\.warn\('email findable check:', publicErrorMessage\(err\)\);\s+\}/);
    assert.match(handler, /await openClaimHold\(ctx, user, siteAcc, amountEth, listed, \{\s+toLabel: claimRecipientLabel\(recipient\),\s+toRaw: recipient\.email,\s+recipient,\s+\}\);/);
  });

  it('the question offers exactly send now and hold, and is read by the router', () => {
    assert.match(claims, /\{ keyword: 'now', label: `Send now, straight to @\$\{found\.username\}'s wallet` \}/);
    assert.match(claims, /\{ keyword: 'claim', label: 'Hold as a claim' \}/);
    assert.match(claims, /kind: 'emailSend',/);
    assert.match(router, /if \(choice\.kind === 'emailSend'\) \{\s+await answerEmailSendChoice\(ctx, user, account, choice, picked\.keyword\);/);
  });

  it('hold runs the email send again with the question skipped', () => {
    assert.match(router, /if \(keyword === 'claim'\) \{\s+await handleSend\(ctx, user, account, r\.amountEth, choice\.email, false, false, r\.asset \|\| 'ETH', null, true,[^)]*\{\s+emailHold: true,\s+\}\);/);
    assert.match(router, /holdOnly: extra\.emailHold === true,/);
  });

  it('send now re-checks the same account, then pays its wallet by id, never by a name', () => {
    const fn = router.slice(router.indexOf('async function answerEmailSendChoice('), router.indexOf('async function dispatchNamedNftSend('));
    assert.match(fn, /if \(!found \|\| found\.id !== choice\.accountId\) \{/);
    assert.match(fn, /\.select\('agent_wallet_address'\)\s+\.eq\('id', found\.id\)/);
    assert.match(fn, /await handleSendResolved\(ctx, user, r\.amountEth, \{ address: dest\.address, label: `@\$\{found\.username\}` \}, siteAcc, \{\s+skipTrusted: true,/);
    assert.doesNotMatch(fn, /resolveSendTarget|resolveFlizyPayDestination/);
  });
});

describe('after a hold, the sender learns nothing the recipient did not agree to', () => {
  const router = read('lib/router.js');
  const hold = router.slice(router.indexOf("if (plan.intent === 'CLAIM_HOLD') {"), router.indexOf("if (plan.intent === 'NFT_MINT') {"));

  it('says "on Flizy" for an email claim only when that account opted in', () => {
    assert.match(hold, /if \(isEmailClaim && notified && recipient\?\.email\) \{\s+try \{\s+emailOnFlizyShown = Boolean\(await findOptedInAccountByEmail\(recipient\.email\)\);/);
    assert.match(hold, /: isEmailClaim\s+\? emailOnFlizyShown\s+\? 'They are on Flizy and have just been notified\./);
  });

  it('otherwise one line for both cases, and the link to forward either way', () => {
    assert.match(hold, /const toldSender = neutralEmail \? false : notified;/);
    assert.match(hold, /neutralEmail \? \(notified \|\| toldOn \? 'We let them know\.' : null\)/);
    assert.match(hold, /toldSender \? null : 'Forward them the next message\. It has the claim link\.'/);
    assert.match(hold, /if \(!toldSender && result\.claim\) \{/);
  });
});

describe('the setting', () => {
  const route = read('web/app/api/account/email-findable/route.ts');

  it('checks origin, then the session, before writing; takes a boolean only', () => {
    const post = route.slice(route.indexOf('export async function POST'));
    assert.ok(post.indexOf('rejectIfCrossOrigin(req)') < post.indexOf('getAccountIdFromCookie()'));
    assert.ok(post.indexOf('getAccountIdFromCookie()') < post.indexOf('.update('));
    assert.match(post, /if \(typeof body\?\.enabled !== 'boolean'\) \{/);
    assert.match(post, /\.update\(\{ findable_by_email: body\.enabled \}\)\s+\.eq\('id', accountId\)/);
    assert.match(route, /return NextResponse\.json\(\{ enabled: data\?\.findable_by_email === true \}\);/);
  });

  it('the migration adds it off by default and fails loudly when it did not land', () => {
    const sql = read('supabase/migrations/20261119120000_findable_by_email.sql');
    assert.match(sql, /add column if not exists findable_by_email boolean not null default false;/);
    assert.match(sql, /raise exception/);
  });

  it('the switch sits in Privacy & Visibility, saying what each side means', () => {
    const ui = read('web/components/AccountProfile.tsx');
    assert.match(ui, /<EmailFindableToggle \/>/);
    assert.match(ui, /People who know my email can find me/);
    assert.match(ui, /Off: sends to your email are held as claims, and no one can tell you are on Flizy\./);
  });
});
