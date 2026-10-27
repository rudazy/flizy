/**
 * Follow rules, the public profile shape, and the routes that serve them.
 *
 * The store talks to Supabase, so these tests stay on the pure rules and on
 * the source of the routes. They do not open a database connection.
 *
 * Run: node --test test/follows.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('decideFollow', () => {
  let decideFollow;

  it('follows once, refuses self and a missing profile, and keeps alerts on a real follow', async () => {
    ({ decideFollow } = await import('../web/lib/follows.ts'));
    const open = { viewerId: 'a', targetId: 'b', targetOpen: true, already: false };
    assert.deepEqual(decideFollow({ ...open, action: 'follow' }), { ok: true, write: 'insert' });
    assert.deepEqual(decideFollow({ ...open, already: true, action: 'follow' }), { ok: true, write: 'keep' });
    assert.deepEqual(decideFollow({ ...open, action: 'unfollow' }), { ok: true, write: 'delete' });
    assert.deepEqual(decideFollow({ ...open, targetId: null, action: 'follow' }), {
      ok: false,
      status: 404,
      error: 'No profile with that username.',
    });
    assert.deepEqual(decideFollow({ ...open, targetOpen: false, action: 'follow' }), {
      ok: false,
      status: 404,
      error: 'No profile with that username.',
    });
    assert.deepEqual(decideFollow({ ...open, targetId: 'a', action: 'follow' }), {
      ok: false,
      status: 400,
      error: 'You cannot follow yourself.',
    });
    assert.deepEqual(decideFollow({ ...open, action: 'alerts' }), {
      ok: false,
      status: 409,
      error: 'Follow them first.',
    });
    assert.deepEqual(decideFollow({ ...open, already: true, action: 'alerts' }), { ok: true, write: 'alerts' });
    assert.deepEqual(decideFollow({ ...open, action: 'copy' }), {
      ok: false,
      status: 409,
      error: 'Follow them first.',
    });
    assert.deepEqual(decideFollow({ ...open, already: true, action: 'copy' }), { ok: true, write: 'copy' });
  });
});

describe('username prefixes', () => {
  let listPrefix;
  let searchPrefix;
  let profilePath;

  it('accepts a leading slice and requires two characters to search', async () => {
    ({ listPrefix, searchPrefix, profilePath } = await import('../web/lib/follows.ts'));
    assert.deepEqual(listPrefix(''), { ok: true, prefix: '' });
    assert.deepEqual(listPrefix('@Ada'), { ok: true, prefix: 'ada' });
    assert.deepEqual(listPrefix('nope!'), { ok: false });
    assert.deepEqual(searchPrefix(''), { ok: false, empty: true });
    assert.deepEqual(searchPrefix('a'), { ok: false, empty: false });
    assert.deepEqual(searchPrefix('@ab'), { ok: true, prefix: 'ab' });
    assert.equal(profilePath('ada'), '/u/ada');
  });
});

describe('public profile', () => {
  let publicProfile;
  let publicPerson;

  const base = {
    username: 'ada',
    displayName: 'Ada',
    isSelf: false,
    signedIn: true,
    following: true,
    alerts: true,
    copyTrade: false,
    showSocial: true,
    showStats: true,
    showActivity: false,
    followers: 4,
    followingCount: 2,
    swaps: 3,
    volumeEth: 1.2,
    activity: [{ title: 'Swapped', detail: 'ETH for FLZ', at: '2h ago' }],
    followedBy: [
      { username: 'bea', displayName: null },
      { username: 'cam', displayName: null },
      { username: 'dee', displayName: null },
      { username: 'eli', displayName: null },
    ],
    followedByCapped: false,
  };

  it('hides counts and the follow state from other people when the switches are off', async () => {
    ({ publicProfile, publicPerson } = await import('../web/lib/follows.ts'));
    const hidden = publicProfile({ ...base, showSocial: false, showStats: false, isSelf: false });
    assert.equal(hidden.followers, null);
    assert.equal(hidden.followingCount, null);
    assert.equal(hidden.swaps, null);
    assert.equal(hidden.volumeEth, null);
    assert.deepEqual(hidden.activity, []);
    assert.deepEqual(hidden.followedBy, []);
    assert.equal(hidden.followedByMore, 0);
    assert.equal(hidden.following, true);

    const owner = publicProfile({ ...base, showSocial: false, showStats: false, isSelf: true, following: true, copyTrade: true });
    assert.equal(owner.followers, 4);
    assert.equal(owner.followingCount, 2);
    assert.equal(owner.swaps, 3);
    assert.equal(owner.volumeEth, 1.2);
    assert.equal(owner.activity.length, 1);
    assert.equal(owner.following, false);
    assert.equal(owner.copyTrade, false);
    assert.equal(owner.followedBy.length, 3);
    assert.equal(owner.followedByMore, 1);

    const quiet = publicProfile(base);
    assert.deepEqual(quiet.activity, []);
    assert.equal(quiet.followers, 4);
    assert.equal(quiet.swaps, 3);
    assert.equal(quiet.volumeEth, 1.2);
    assert.equal(quiet.copyTrade, false);

    const opened = publicProfile({ ...base, showActivity: true, copyTrade: true });
    assert.equal(opened.activity.length, 1);
    assert.equal(opened.followers, 4);
    assert.equal(opened.copyTrade, true);

    const shown = publicProfile(base);
    assert.equal(shown.followedBy.length, 3);
    assert.equal(shown.followedByMore, 1);
    assert.equal(JSON.stringify(shown).includes('id'), false);
    assert.equal(publicPerson({ username: 'ada', display_name: 'Ada' }).username, 'ada');
    assert.equal(publicPerson({ username: 'no', display_name: 'No' }), null);
  });
});

describe('swap lines and volume', () => {
  let publicSwap;
  let formatVolumeEth;
  let relativeTime;

  it('prints symbols only, and matches the account volume cuts', async () => {
    ({ publicSwap, formatVolumeEth, relativeTime } = await import('../web/lib/follows.ts'));
    const now = Date.parse('2026-10-27T12:00:00.000Z');
    const line = publicSwap(
      {
        status: 'confirmed',
        kind: 'swap',
        asset: 'eth',
        asset_secondary: 'tusd',
        created_at: '2026-10-27T10:00:00.000Z',
      },
      now
    );
    assert.equal(line.title, 'Swapped');
    assert.equal(line.detail, 'ETH for tUSD');
    assert.equal(line.at, '2h ago');

    const address = '0x' + 'ab'.repeat(20);
    const dropped = publicSwap(
      { status: 'confirmed', kind: 'swap', asset: address, asset_secondary: address, created_at: '2026-10-27T12:00:00.000Z' },
      now
    );
    assert.equal(dropped.detail, 'On GIWA');
    assert.equal(JSON.stringify(dropped).includes('0x'), false);
    assert.equal(publicSwap({ status: 'pending', kind: 'swap', asset: 'eth', asset_secondary: 'flz' }, now), null);
    assert.equal(publicSwap({ status: 'confirmed', kind: 'send', asset: 'eth', asset_secondary: 'flz' }, now), null);

    assert.equal(formatVolumeEth(0), '0');
    assert.equal(formatVolumeEth(-1), '0');
    assert.equal(formatVolumeEth(0.0004), '<0.001');
    assert.equal(formatVolumeEth(0.5), '0.5');
    assert.equal(formatVolumeEth(12.345), '12.35');
    assert.equal(relativeTime('2026-10-27T12:00:30.000Z', now), 'Just now');
    assert.equal(relativeTime('2026-09-01T12:00:00.000Z', now), '2026-09-01');
  });
});

describe('follow rate', () => {
  it('stops at the limit and does not count the refusal', async () => {
    const { takeBudget } = await import('../web/lib/followRate.ts');
    const store = new Map();
    assert.equal(takeBudget(store, 'a', 2, 1000, 0), true);
    assert.equal(takeBudget(store, 'a', 2, 1000, 10), true);
    assert.equal(takeBudget(store, 'a', 2, 1000, 20), false);
    assert.equal(store.get('a').length, 2);
    assert.equal(takeBudget(store, 'a', 2, 1000, 2000), true);

    const crowded = new Map();
    for (let i = 0; i < 5000; i += 1) takeBudget(crowded, `k${i}`, 2, 1000, 0);
    assert.equal(takeBudget(crowded, 'live', 2, 1000, 0), true);
    assert.equal(takeBudget(crowded, 'live', 2, 1000, 10), true);
    assert.equal(takeBudget(crowded, 'live', 2, 1000, 20), false);
    assert.equal(crowded.get('live').length, 2);
  });
});

describe('account_follows migration', () => {
  const sql = read('supabase/migrations/20261027120000_account_follows.sql');

  it('keeps one row per pair, blocks self follows, caps at 1000, and locks the table down', () => {
    assert.match(sql, /primary key \(follower_id, following_id\)/);
    assert.match(sql, /account_follows_not_self check \(follower_id <> following_id\)/);
    assert.match(sql, /alerts boolean not null default true/);
    assert.match(sql, /profile_show_social boolean not null default true/);
    assert.match(sql, /profile_show_stats boolean not null default true/);
    assert.match(sql, /if held >= 1000 then/);
    assert.match(sql, /raise exception 'account_follows_cap'/);
    assert.match(sql, /enable row level security/);
    assert.match(sql, /revoke all on table public\.account_follows from anon, authenticated/);
    assert.match(sql, /grant all on table public\.account_follows to service_role/);
    assert.match(sql, /grant execute on function public\.account_follows_before_insert\(\) to service_role/);
    assert.match(sql, /revoke all on function public\.account_follows_before_insert\(\) from public/);
    assert.match(sql, /revoke all on function public\.account_follows_before_insert\(\) from anon, authenticated/);
    assert.match(sql, /drop trigger if exists account_follows_before_insert/);
    assert.match(sql, /account_follows is missing/);
    assert.match(sql, /profile visibility columns are missing/);
    assert.doesNotMatch(sql, /grant .+ to anon/i);
  });
});

describe('activity and copy trade migration', () => {
  const sql = read('supabase/migrations/20261027140000_profile_activity_copy.sql');

  it('hides activity by default and stores copy trade as a choice', () => {
    assert.match(sql, /profile_show_activity boolean not null default false/);
    assert.match(sql, /copy_trade boolean not null default false/);
    assert.match(sql, /activity and copy trade columns are missing/);
    assert.doesNotMatch(sql, /grant .+ to anon/i);
  });
});

describe('follow routes', () => {
  const follow = read('web/app/api/u/[username]/follow/route.ts');
  const profile = read('web/app/api/u/[username]/route.ts');
  const followers = read('web/app/api/u/[username]/followers/route.ts');
  const following = read('web/app/api/u/[username]/following/route.ts');
  const people = read('web/app/api/people/route.ts');
  const own = read('web/app/api/follow/route.ts');
  const store = read('web/lib/followStore.ts');

  it('takes a session and the same origin, and never a PIN, password, or wallet', () => {
    for (const src of [follow, own]) {
      assert.match(src, /rejectIfCrossOrigin/);
      assert.match(src, /getAccountIdFromCookie/);
      assert.doesNotMatch(src, /requirePassword|requireStepUp|privy|body\.pin/);
    }
    assert.match(follow, /Not logged in/);
    assert.match(follow, /Choose alerts or copy trade/);
    assert.match(follow, /copyTrade/);
    assert.match(store, /copy_trade/);
    assert.match(store, /profile_show_activity/);
    assert.match(store, /isMissingClosureColumn/);
    assert.match(profile, /ClientError/);
    assert.match(profile, /status: 503/);
    assert.doesNotMatch(profile, /Not logged in/);
    assert.match(followers, /listPrefix/);
    assert.match(following, /listPrefix/);
    assert.match(people, /searchPrefix/);
    assert.match(people, /suggestPeople/);
    assert.match(store, /ignoreDuplicates: true/);
    assert.match(store, /onConflict: 'follower_id,following_id'/);
    assert.match(store, /You can follow up to 1000 people/);
    assert.doesNotMatch(store, /email|phone|password|wallet_address|privy/i);
  });
});

describe('follow screens', () => {
  const account = read('web/components/AccountProfile.tsx');
  const pub = read('web/components/PublicProfile.tsx');
  const nav = read('web/components/AppBottomNav.tsx');

  it('follows from someone else\'s profile and edits your own', () => {
    assert.match(pub, />\s*Follow\s*</);
    assert.match(pub, />\s*Following\s*</);
    assert.match(pub, />\s*Unfollow\s*</);
    assert.match(pub, /Edit profile/);
    assert.match(pub, /Sign in to follow/);
    assert.match(pub, /Activity alerts/);
    assert.match(pub, /Saved on this follow\. No alert is sent yet\./);
    assert.match(pub, /aria-label="Copy trade"/);
    assert.match(pub, /Nothing is copied yet\./);
    assert.match(pub, /Activity is hidden from others\./);
    assert.match(pub, />\s*Activity\s*</);
    assert.match(account, /Show activity/);
    assert.match(pub, /\/pay\//);
    assert.doesNotMatch(pub, /Message/);
    assert.doesNotMatch(account, /onSoon\('Follow'\)/);
    assert.doesNotMatch(account, />\s*Follow\s*</);
    assert.match(account, /Find people/);
    assert.match(account, /Show trading stats/);
    assert.match(account, /Show followers & following/);
    assert.doesNotMatch(nav, /href: '\/people'/);
    assert.match(read('web/app/u/[username]/page.tsx'), /noindex: true/);
    assert.match(read('web/app/people/page.tsx'), /noindex: true/);
    assert.doesNotMatch(read('web/app/sitemap.ts'), /\/people|\/u\//);
    assert.doesNotMatch(read('web/app/robots.ts'), /disallow: \[[^\]]*\/people|disallow: \[[^\]]*\/u\//);
    assert.match(read('web/public/llms.txt'), /\/u\/:username/);
    assert.match(read('web/public/llms.txt'), /flizy\.app\/people/);
    assert.match(read('web/app/privacy/page.tsx'), /27 October 2026/);
    assert.match(read('web/app/privacy/page.tsx'), /Following does not send a payment/);
    assert.match(read('web/app/privacy/page.tsx'), /nothing is copied yet/);
    assert.match(read('web/app/privacy/page.tsx'), /Show activity/);
  });
});
