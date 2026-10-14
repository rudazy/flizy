/**
 * Email to the owner when a chat is linked or unlinked.
 *
 * The bots hold no mail credentials, so a bot asks the site
 * (web/app/api/internal/security-mail) with a shared secret, and the site mails
 * only an event it finds in identity_events from the last few minutes. These
 * tests hold each half: what the bot sends and where, what the route accepts,
 * and what the mail says.
 *
 * Run: node --test test/securityMail.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { requestSecurityMail, securityMailUrl } = require('../lib/securityMail');

const ROOT = path.join(__dirname, '..');
const ROUTE_SRC = fs.readFileSync(path.join(ROOT, 'web/app/api/internal/security-mail/route.ts'), 'utf8');

const ACC = '0b6f8a52-7a8e-4f7e-9c1a-1d2e3f405162';
const SECRET = 's'.repeat(48);

let notice;
let bearer;

before(async () => {
  notice = await import('../web/lib/securityNotice.ts');
  bearer = await import('../web/lib/bearerSecret.ts');
});

describe('the bot asks the site', () => {
  function recorder(status = 200) {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status };
    };
    return { calls, fetch };
  }

  it('posts only the account id and the kind, with the secret as a bearer token', async () => {
    const r = recorder();
    const out = await requestSecurityMail(ACC, 'unlinked', { fetch: r.fetch, secret: SECRET, siteUrl: 'https://flizy.test' });
    assert.equal(out, 'sent');
    assert.equal(r.calls.length, 1);
    const { url, init } = r.calls[0];
    assert.equal(url, 'https://flizy.test/api/internal/security-mail');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, `Bearer ${SECRET}`);
    assert.deepEqual(JSON.parse(init.body), { accountId: ACC, kind: 'unlinked' });
    assert.equal(init.redirect, 'error', 'a redirect would carry the token elsewhere');
    assert.ok(init.signal, 'bounded by a timeout');
  });

  it('never sends the secret over plain http, except to a local site', () => {
    assert.equal(securityMailUrl('http://flizy.test'), null);
    assert.equal(securityMailUrl('not a url'), null);
    assert.equal(securityMailUrl('http://localhost:3000'), 'http://localhost:3000/api/internal/security-mail');
  });

  it('does nothing without a secret or a known kind', async () => {
    const r = recorder();
    assert.equal(await requestSecurityMail(ACC, 'unlinked', { fetch: r.fetch, secret: '', siteUrl: 'https://flizy.test' }), 'unconfigured');
    assert.equal(await requestSecurityMail(ACC, 'deleted', { fetch: r.fetch, secret: SECRET, siteUrl: 'https://flizy.test' }), 'skipped');
    assert.equal(await requestSecurityMail('', 'linked', { fetch: r.fetch, secret: SECRET, siteUrl: 'https://flizy.test' }), 'skipped');
    assert.equal(r.calls.length, 0);
  });

  it('never throws, whatever the site does', async () => {
    const refused = recorder(401);
    assert.equal(await requestSecurityMail(ACC, 'linked', { fetch: refused.fetch, secret: SECRET, siteUrl: 'https://flizy.test' }), 'failed');
    const down = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    assert.equal(await requestSecurityMail(ACC, 'linked', { fetch: down, secret: SECRET, siteUrl: 'https://flizy.test' }), 'failed');
  });
});

describe('the site route', () => {
  it('checks the bearer secret before reading anything', () => {
    const auth = ROUTE_SRC.indexOf("bearerMatches(req.headers.get('authorization'), process.env.SECURITY_MAIL_SECRET)");
    assert.ok(auth > 0);
    for (const later of ['req.json()', 'getSupabase()', 'recentChatEvent(']) {
      assert.ok(ROUTE_SRC.indexOf(later) > auth, later);
    }
  });

  it('mails only an event it found, to the owner, in its own words', () => {
    assert.match(ROUTE_SRC, /if \(!event\) \{\s*return NextResponse\.json\(\{ ok: false \}, \{ status: 404/);
    assert.match(ROUTE_SRC, /mailOwner\(supabase, accountId, chatChangeMail\(siteOrigin\(\), event, chats\)\)/);
    assert.match(ROUTE_SRC, /const UUID = /);
  });

  it('bearerMatches refuses an unset secret, a wrong one and a missing header', () => {
    assert.equal(bearer.bearerMatches(`Bearer ${SECRET}`, SECRET), true);
    assert.equal(bearer.bearerMatches(`Bearer ${SECRET}x`, SECRET), false);
    assert.equal(bearer.bearerMatches(null, SECRET), false);
    assert.equal(bearer.bearerMatches('Bearer ', ''), false);
    assert.equal(bearer.bearerMatches('Bearer undefined', undefined), false);
  });
});

describe('recentChatEvent', () => {
  const NOW = new Date('2026-10-14T12:00:00Z');
  const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

  function db(events) {
    return createFakeSupabase({ identity_events: events }).client;
  }

  it('finds a chat unlink from the last ten minutes', async () => {
    const ev = await notice.recentChatEvent(
      db([{ account_id: ACC, channel: 'whatsapp', external_id: '2348011112222', display_handle: null, event_type: 'UNLINKED', created_at: minutesAgo(2) }]),
      ACC,
      'unlinked',
      NOW
    );
    assert.equal(ev.channel, 'whatsapp');
    assert.equal(ev.label, 'ending 2222');
    assert.equal(ev.kind, 'unlinked');
  });

  it('finds nothing older, of another kind, on another account, or on a platform channel', async () => {
    const rows = [
      { account_id: ACC, channel: 'whatsapp', external_id: '1', event_type: 'UNLINKED', created_at: minutesAgo(11) },
      { account_id: ACC, channel: 'whatsapp', external_id: '2', event_type: 'LINKED', created_at: minutesAgo(1) },
      { account_id: 'someone-else', channel: 'telegram', external_id: '3', event_type: 'UNLINKED', created_at: minutesAgo(1) },
      { account_id: ACC, channel: 'github', external_id: '4', event_type: 'UNLINKED', created_at: minutesAgo(1) },
    ];
    assert.equal(await notice.recentChatEvent(db(rows), ACC, 'unlinked', NOW), null);
  });
});

describe('the chat change mail', () => {
  const SITE = 'https://flizy.test';
  const AT = new Date('2026-10-14T09:30:00Z');

  it('unlinked: names the chat, lists what is left, and says what to do', () => {
    const mail = notice.chatChangeMail(
      SITE,
      { kind: 'unlinked', channel: 'telegram', label: '@ada_o', at: AT },
      [{ channel: 'whatsapp', label: 'ending 2222', linkedAt: null }]
    );
    assert.equal(mail.subject, 'A chat was unlinked from your Flizy account');
    assert.match(mail.text, /^Telegram \(@ada_o\) was unlinked from your Flizy account on /);
    assert.match(mail.text, /Chats linked to this account now:\n {2}- WhatsApp \(ending 2222\)/);
    assert.match(mail.text, /Change your password: https:\/\/flizy\.test\/dashboard\/account\?s=security/);
    assert.match(mail.text, /Set a new PIN/);
  });

  it('linked: says the chat cannot move money until unlocked', () => {
    const mail = notice.chatChangeMail(SITE, { kind: 'linked', channel: 'whatsapp', label: 'ending 2222', at: AT }, []);
    assert.equal(mail.subject, 'A chat was linked to your Flizy account');
    assert.match(mail.text, /cannot move money until it is unlocked with your PIN/);
    assert.match(mail.text, /\(none\)/);
    assert.match(mail.text, /Unlink it: https:\/\/flizy\.test\/dashboard\/account\?s=chat/);
  });
});
