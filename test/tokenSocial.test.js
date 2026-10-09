/**
 * The social side of the token page, driven through web/lib/tokenSocial.ts:
 * admin-only profile edits, the watchlist, and theses with likes, comments
 * and their limits. Replies name people by @username, never by account id.
 *
 * Run: node --test test/tokenSocial.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

let S;
let fake;

before(async () => {
  S = await import('../web/lib/tokenSocial.ts');
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const ADMIN = 'acc-admin';
const ANN = 'acc-ann';
const BEN = 'acc-ben';
const NONAME = 'acc-noname';

function seed() {
  fake = createFakeSupabase({
    accounts: [
      { id: ADMIN, username: 'ludarep', is_admin: true },
      { id: ANN, username: 'ann', is_admin: false },
      { id: BEN, username: 'ben', is_admin: false },
      { id: NONAME, username: null, is_admin: false },
    ],
    token_profiles: [{ token_key: 'flz', description: '', links: [] }],
    token_watchlist: [],
    token_theses: [],
    token_thesis_likes: [],
    token_thesis_comments: [],
  });
}

const c = () => fake.client;
const dataUrl = (kind, bytes) => `data:image/${kind};base64,${Buffer.from(bytes).toString('base64')}`;
const PNG = dataUrl('png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2]);

describe('listed tokens only', () => {
  beforeEach(seed);

  it('accepts flz in any case and refuses anything else', async () => {
    assert.equal(S.listedTokenKey('FLZ'), 'flz');
    assert.equal(S.listedTokenKey('0x' + '1'.repeat(40)), null);
    await assert.rejects(() => S.postThesis(ANN, 'usdc', { sentiment: 'bullish', body: 'x' }, c()), { message: 'This token is not listed.' });
    await assert.rejects(() => S.setWatched(ANN, 'pepe', true, c()), { message: 'This token is not listed.' });
  });
});

describe('token profile', () => {
  beforeEach(seed);

  it('is edited by an admin only', async () => {
    await assert.rejects(() => S.updateTokenProfile(ANN, 'flz', { description: 'Mine now' }, c()), {
      message: 'Only Flizy admins can edit a token profile.',
    });
    const saved = await S.updateTokenProfile(
      ADMIN,
      'flz',
      {
        logo: PNG,
        description: 'A social crypto wallet.',
        links: [{ kind: 'website', label: 'Website', url: 'https://flizy.app' }],
        creatorUsername: '@ludarep',
      },
      c()
    );
    assert.deepEqual(saved, {
      logo: PNG,
      description: 'A social crypto wallet.',
      links: [{ kind: 'website', label: 'Website', url: 'https://flizy.app' }],
      creatorUsername: 'ludarep',
    });
  });

  it('refuses a creator that is not an account, an http link, an SVG logo, and too many links', async () => {
    await assert.rejects(() => S.updateTokenProfile(ADMIN, 'flz', { creatorUsername: 'nobodyhere' }, c()), /No Flizy account/);
    await assert.rejects(() => S.updateTokenProfile(ADMIN, 'flz', { links: [{ kind: 'website', label: 'W', url: 'http://x.y' }] }, c()), /https/);
    await assert.rejects(() => S.updateTokenProfile(ADMIN, 'flz', { logo: 'data:image/svg+xml;base64,PHN2Zz4=' }, c()), /PNG, JPEG or WebP/);
    const nine = Array.from({ length: 9 }, (_, i) => ({ kind: 'custom', label: 'L', url: `https://e.com/${i}` }));
    await assert.rejects(() => S.updateTokenProfile(ADMIN, 'flz', { links: nine }, c()), /8 links/);
  });
});

describe('watchlist', () => {
  beforeEach(seed);

  it('stars and unstars, once per account', async () => {
    assert.equal(await S.isWatched(ANN, 'flz', c()), false);
    await S.setWatched(ANN, 'flz', true, c());
    await S.setWatched(ANN, 'flz', true, c());
    assert.equal(await S.isWatched(ANN, 'flz', c()), true);
    assert.equal(fake.db.tables.token_watchlist.length, 1);
    assert.deepEqual(await S.listWatched(ANN, c()), ['flz']);
    assert.equal(await S.isWatched(BEN, 'flz', c()), false);
    await S.setWatched(ANN, 'flz', false, c());
    assert.deepEqual(await S.listWatched(ANN, c()), []);
  });
});

describe('theses', () => {
  beforeEach(seed);

  it('needs a username, a sentiment from the list, and some text within the limit', async () => {
    await assert.rejects(() => S.postThesis(NONAME, 'flz', { sentiment: 'bullish', body: 'Hi' }, c()), { message: 'Choose a username to post.' });
    await assert.rejects(() => S.postThesis(ANN, 'flz', { sentiment: 'moon', body: 'Hi' }, c()), /Bullish, Neutral or Bearish/);
    await assert.rejects(() => S.postThesis(ANN, 'flz', { sentiment: 'bullish', body: '   ' }, c()), /Write your thesis/);
    await assert.rejects(() => S.postThesis(ANN, 'flz', { sentiment: 'bullish', body: 'x'.repeat(501) }, c()), /500 characters/);
  });

  it('lists newest first by @username, with counts, and no account ids', async () => {
    const first = await S.postThesis(ANN, 'flz', { sentiment: 'bullish', body: 'Usable crypto.' }, c());
    fake.db.tables.token_theses[0].created_at = new Date(Date.now() - 60e3).toISOString();
    await S.postThesis(BEN, 'flz', { sentiment: 'neutral', body: 'Watching liquidity.' }, c());
    await S.toggleLike(BEN, 'flz', first.id, c());
    await S.postComment(BEN, 'flz', first.id, 'Agreed.', c());

    const { theses, total } = await S.listTheses('flz', ANN, {}, c());
    assert.equal(total, 2);
    const ann = theses.find((t) => t.username === 'ann');
    assert.equal(ann.likes, 1);
    assert.equal(ann.comments, 1);
    assert.equal(ann.likedByViewer, false);
    assert.equal(ann.canDelete, true);
    assert.equal(theses.find((t) => t.username === 'ben').canDelete, false);
    const json = JSON.stringify(theses);
    for (const id of [ADMIN, ANN, BEN]) assert.equal(json.includes(id), false);
  });

  it('holds the daily limits, counting deleted posts too', async () => {
    for (let i = 0; i < S.THESES_PER_TOKEN_PER_DAY; i += 1) {
      const t = await S.postThesis(ANN, 'flz', { sentiment: 'neutral', body: `Take ${i}` }, c());
      await S.deleteThesis(ANN, 'flz', t.id, c());
    }
    await assert.rejects(() => S.postThesis(ANN, 'flz', { sentiment: 'neutral', body: 'One more' }, c()), /3 theses on a token a day/);
  });

  it('lets the author or an admin delete, and hides a deleted thesis', async () => {
    const t = await S.postThesis(ANN, 'flz', { sentiment: 'bearish', body: 'Too early.' }, c());
    await assert.rejects(() => S.deleteThesis(BEN, 'flz', t.id, c()), { message: 'You can only delete your own thesis.' });
    await S.deleteThesis(ADMIN, 'flz', t.id, c());
    assert.equal((await S.listTheses('flz', ANN, {}, c())).total, 0);
    await assert.rejects(() => S.toggleLike(BEN, 'flz', t.id, c()), /not there any more/);
    await assert.rejects(() => S.postComment(BEN, 'flz', t.id, 'Late', c()), /not there any more/);
  });

  it('toggles a like, one per account', async () => {
    const t = await S.postThesis(ANN, 'flz', { sentiment: 'bullish', body: 'Yes.' }, c());
    assert.deepEqual(await S.toggleLike(BEN, 'flz', t.id, c()), { liked: true, likes: 1 });
    assert.deepEqual(await S.toggleLike(ADMIN, 'flz', t.id, c()), { liked: true, likes: 2 });
    assert.deepEqual(await S.toggleLike(BEN, 'flz', t.id, c()), { liked: false, likes: 1 });
  });

  it('comments need a username and text, and the author or an admin can remove them', async () => {
    const t = await S.postThesis(ANN, 'flz', { sentiment: 'bullish', body: 'Yes.' }, c());
    await assert.rejects(() => S.postComment(NONAME, 'flz', t.id, 'Hi', c()), /username to comment/);
    await assert.rejects(() => S.postComment(BEN, 'flz', t.id, 'x'.repeat(301), c()), /300 characters/);
    const comment = await S.postComment(BEN, 'flz', t.id, 'Nice.', c());
    assert.equal(comment.username, 'ben');
    await assert.rejects(() => S.deleteComment(ANN, 'flz', t.id, comment.id, c()), /your own comment/);
    await S.deleteComment(ADMIN, 'flz', t.id, comment.id, c());
    assert.deepEqual(await S.listComments('flz', t.id, ANN, c()), []);
  });

  it('slows down a flood of comments', async () => {
    const t = await S.postThesis(ANN, 'flz', { sentiment: 'bullish', body: 'Yes.' }, c());
    for (let i = 0; i < S.COMMENTS_PER_HOUR; i += 1) {
      fake.db.tables.token_thesis_comments.push({ id: `c${i}`, thesis_id: t.id, account_id: BEN, body: 'x', created_at: new Date().toISOString(), deleted_at: null });
    }
    await assert.rejects(() => S.postComment(BEN, 'flz', t.id, 'again', c()), /very fast/);
  });
});

describe('token social source', () => {
  const ROOT = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('keeps every write same-site and signed in', () => {
    const routes = [
      'web/app/api/tokens/[symbol]/profile/route.ts',
      'web/app/api/tokens/[symbol]/watch/route.ts',
      'web/app/api/tokens/[symbol]/theses/route.ts',
      'web/app/api/tokens/[symbol]/theses/[id]/route.ts',
      'web/app/api/tokens/[symbol]/theses/[id]/like/route.ts',
      'web/app/api/tokens/[symbol]/theses/[id]/comments/route.ts',
      'web/app/api/tokens/[symbol]/theses/[id]/comments/[commentId]/route.ts',
    ];
    for (const rel of routes) {
      const src = read(rel);
      assert.match(src, /getAccountIdFromCookie\(\)/, rel);
      if (/export async function (POST|PATCH|DELETE)/.test(src)) assert.match(src, /rejectIfCrossOrigin\(req\)/, rel);
    }
  });

  it('keeps the new tables and function away from anon and authenticated', () => {
    const sql = read('supabase/migrations/20261012120000_token_social.sql');
    for (const t of ['token_profiles', 'token_watchlist', 'token_theses', 'token_thesis_likes', 'token_thesis_comments']) {
      assert.match(sql, new RegExp(`revoke all on table public\\.${t} from anon, authenticated;`));
    }
    assert.match(sql, /revoke all on function public\.token_thesis_counts\(uuid\[\]\) from anon, authenticated;/);
    assert.match(sql, /raise exception 'token_profiles has no flz row'/);
  });
});
