/**
 * Who an email comes from (web/lib/sendMail.ts).
 *
 * Covers: codes and security notices go from EMAIL_FROM; email about money
 * moving (claim emails, payment received, large API payouts) goes from
 * PAYMENTS_EMAIL_FROM with Reply-To payments@flizy.app, and falls back to
 * EMAIL_FROM; with no From set, production refuses to send and nothing is
 * guessed; Gmail SMTP is tried first and Resend only after it; no old sender
 * address is left anywhere.
 *
 * Run: node --test test/mailSenders.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let S;
let N;
let P;
before(async () => {
  S = await import('../web/lib/sendMail.ts');
  N = await import('../web/lib/securityNotice.ts');
  P = await import('../web/lib/apiPayouts.ts');
});

const BOTH = {
  NODE_ENV: 'production',
  EMAIL_FROM: 'Flizy <noreply@flizy.app>',
  PAYMENTS_EMAIL_FROM: 'Flizy Pay <payments@flizy.app>',
};
const MSG = { to: 'ada@example.com', subject: 's', text: 't' };

/** A transport that records what it was handed and answers `out`. */
function recorder(out = { ok: true, id: 'x' }) {
  const seen = [];
  const t = async (mail) => (seen.push(mail), out);
  return { t, seen };
}

describe('the sender for each kind of email', () => {
  it('default: EMAIL_FROM, and no Reply-To', () => {
    assert.deepEqual(S.senderFor('default', BOTH), { from: 'Flizy <noreply@flizy.app>' });
    assert.deepEqual(S.senderFor(undefined, BOTH), { from: 'Flizy <noreply@flizy.app>' });
  });

  it('payments: PAYMENTS_EMAIL_FROM, Reply-To payments@flizy.app', () => {
    assert.equal(S.PAYMENTS_REPLY_TO, undefined, 'the address lives in publicMail.ts only');
    assert.deepEqual(S.senderFor('payments', BOTH), { from: 'Flizy Pay <payments@flizy.app>', replyTo: 'payments@flizy.app' });
  });

  it('payments without PAYMENTS_EMAIL_FROM falls back to EMAIL_FROM, Reply-To kept', () => {
    assert.deepEqual(S.senderFor('payments', { EMAIL_FROM: 'Flizy <noreply@flizy.app>', PAYMENTS_EMAIL_FROM: '  ' }), {
      from: 'Flizy <noreply@flizy.app>',
      replyTo: 'payments@flizy.app',
    });
  });

  it('no From set: none, never one made from GMAIL_USER or a provider default', () => {
    const env = { GMAIL_USER: 'someone@gmail.com', RESEND_API_KEY: 'k' };
    assert.equal(S.senderFor('default', env), null);
    assert.equal(S.senderFor('payments', env), null);
  });

  it('a transport receives the From and Reply-To for the sender asked for', async () => {
    const r = recorder();
    await S.sendMail({ ...MSG, sender: 'payments' }, { env: BOTH, transports: [r.t] });
    await S.sendMail(MSG, { env: BOTH, transports: [r.t] });
    assert.equal(r.seen[0].from, 'Flizy Pay <payments@flizy.app>');
    assert.equal(r.seen[0].replyTo, 'payments@flizy.app');
    assert.equal(r.seen[1].from, 'Flizy <noreply@flizy.app>');
    assert.equal(r.seen[1].replyTo, undefined);
    assert.equal('sender' in r.seen[0], false);
  });
});

describe('no From in production', () => {
  it('refuses to send, logs an error, and calls no transport', async () => {
    const r = recorder();
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      const out = await S.sendMail(MSG, { env: { NODE_ENV: 'production', GMAIL_USER: 'x@flizy.app' }, transports: [r.t] });
      const vercel = await S.sendMail({ ...MSG, sender: 'payments' }, { env: { VERCEL_ENV: 'production' }, transports: [r.t] });
      assert.equal(out.ok, false);
      assert.equal(out.code, 'MAIL_NOT_CONFIGURED');
      assert.equal(vercel.ok, false);
    } finally {
      console.error = orig;
    }
    assert.equal(r.seen.length, 0);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /no From address/);
  });

  it('outside production it logs the body instead and sends nothing', async () => {
    const r = recorder();
    const orig = console.warn;
    console.warn = () => {};
    try {
      const out = await S.sendMail(MSG, { env: { NODE_ENV: 'development' }, transports: [r.t] });
      assert.deepEqual(out, { ok: true, id: 'dev-log' });
    } finally {
      console.warn = orig;
    }
    assert.equal(r.seen.length, 0);
  });
});

describe('transport order', () => {
  it('the first that sends wins; an unconfigured one is skipped', async () => {
    const off = async () => null;
    const second = recorder({ ok: true, id: 'resend' });
    assert.deepEqual(await S.sendMail(MSG, { env: BOTH, transports: [off, second.t] }), { ok: true, id: 'resend' });
  });

  it('a failed SMTP send falls back to the next; both failing returns the first error', async () => {
    const smtpDown = async () => ({ ok: false, error: 'Could not send the email. Try again shortly.', code: 'MAIL_SMTP' });
    const ok = recorder({ ok: true, id: 'r' });
    assert.equal((await S.sendMail(MSG, { env: BOTH, transports: [smtpDown, ok.t] })).ok, true);
    const down2 = async () => ({ ok: false, error: 'e', code: 'MAIL_PROVIDER' });
    assert.equal((await S.sendMail(MSG, { env: BOTH, transports: [smtpDown, down2] })).code, 'MAIL_SMTP');
  });

  it('nothing configured in production: not sent', async () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const out = await S.sendMail(MSG, { env: BOTH, transports: [async () => null] });
      assert.equal(out.code, 'MAIL_NOT_CONFIGURED');
    } finally {
      console.error = orig;
    }
  });

  it('SMTP is the default first transport and Resend the second; errors to callers name no setting', () => {
    const src = read('web/lib/sendMail.ts');
    assert.match(src, /deps\.transports \|\| \[sendViaSmtp, sendViaResend\]/);
    assert.match(src, /replyTo: mail\.replyTo/);
    assert.match(src, /reply_to: mail\.replyTo/);
    for (const m of src.matchAll(/error: '([^']+)'/g)) assert.doesNotMatch(m[1], /GMAIL|RESEND|SMTP_|EMAIL_FROM/, m[1]);
  });
});

describe('each email uses its sender', () => {
  it('mailOwner passes the notice sender through, and none for a security notice', async () => {
    const fake = createFakeSupabase({ accounts: [{ id: 'a1', email: 'ada@example.com' }] });
    const calls = [];
    const send = async (m) => (calls.push(m), { ok: true });
    await N.mailOwner(fake.client, 'a1', N.linkCodeMail('https://flizy.app', new Date()), send);
    await N.mailOwner(fake.client, 'a1', { subject: 's', text: 't', sender: 'payments' }, send);
    assert.equal('sender' in calls[0], false);
    assert.equal(calls[1].sender, 'payments');
  });

  it('the large API payout email goes from the payments sender', () => {
    const view = { id: 'po-1', amount: '500', asset: 'tUSD', recipient: { type: 'email', value: 'ada@example.com' }, reference: null, created_at: '2026-11-09T12:00:00Z' };
    assert.equal(P.largePayoutMail(view, 'Acme', 'https://flizy.app').sender, 'payments');
  });

  it('claim emails and payment received ask for the payments sender', () => {
    assert.match(read('web/lib/claimEmail.ts'), /html: mail\.html, sender: 'payments' \}\);/);
    assert.match(read('web/lib/incomingNotice.ts'), /text: built\.text, sender: 'payments' \}\);/);
  });

  it('only those three ask for it; codes and every other notice use the default', () => {
    const found = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name) && /sender: 'payments'/.test(read(rel))) found.push(rel);
      }
    };
    walk('web/lib');
    walk('web/app');
    assert.deepEqual(found.sort(), ['web/lib/apiPayouts.ts', 'web/lib/claimEmail.ts', 'web/lib/incomingNotice.ts']);
    assert.doesNotMatch(read('web/lib/emailVerify.ts'), /sender:/);
  });
});

describe('no old sender is left', () => {
  it('no gmail.com sender or resend.dev default in the mailer, the env examples or the docs', () => {
    for (const rel of ['web/lib/sendMail.ts', '.env.example', 'web/.env.local.example', '.env.dev.example', 'docs/OPERATIONS.md']) {
      const src = read(rel);
      assert.doesNotMatch(src, /flizybuildbot|onboarding@resend\.dev|@gmail\.com/, rel);
    }
  });

  it('none of the mail settings is public', () => {
    for (const rel of ['.env.example', 'web/.env.local.example']) {
      assert.doesNotMatch(read(rel), /NEXT_PUBLIC_(EMAIL|PAYMENTS_EMAIL|GMAIL|RESEND|SMTP)/, rel);
    }
  });
});
