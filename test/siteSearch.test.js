/**
 * Site search: the places index matched in the browser (web/lib/searchIndex.ts)
 * and the live search on the server (web/lib/siteSearch.ts).
 *
 * Run: node --test test/siteSearch.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let I;
let S;
let FAQ;
let fake;

before(async () => {
  I = await import('../web/lib/searchIndex.ts');
  S = await import('../web/lib/siteSearch.ts');
  FAQ = await import('../web/lib/flizyFaq.ts');
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe('places index', () => {
  it('opens the setting people name, ranking exact and prefix matches first', () => {
    assert.equal(I.matchPlaces('pin')[0].href, '/dashboard/account?s=pin');
    assert.equal(I.matchPlaces('faucet')[0].href, '/dashboard/wallet?s=fund');
    assert.equal(I.matchPlaces('test eth')[0].href, '/dashboard/wallet?s=fund');
    assert.equal(I.matchPlaces('whatsapp')[0].href, '/dashboard/account?s=chat');
    assert.equal(I.matchPlaces('password')[0].href, '/dashboard/account?s=security');
    assert.equal(I.matchPlaces('Swap')[0].href, '/dashboard/swap');
    assert.deepEqual(I.matchPlaces('   '), []);
    assert.deepEqual(I.matchPlaces('zzqqxx'), []);
  });

  it('points every place at a real route and a slide the page really has', () => {
    const slides = (rel) => {
      const src = read(rel);
      const m = /const SLIDES = \[([\s\S]*?)\]/.exec(src);
      return m ? [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]) : [];
    };
    const pages = {
      '/dashboard': 'web/app/dashboard/page.tsx',
      '/dashboard/wallet': 'web/app/dashboard/wallet/page.tsx',
      '/dashboard/account': 'web/app/dashboard/account/page.tsx',
      '/dashboard/explore': 'web/app/dashboard/explore/page.tsx',
      '/dashboard/swap': 'web/app/dashboard/swap/page.tsx',
      '/dashboard/explore/new': 'web/app/dashboard/explore/new/page.tsx',
      '/dashboard/explore/nfts/me': 'web/app/dashboard/explore/nfts/me/page.tsx',
      '/dashboard/explore/nfts/mints': 'web/app/dashboard/explore/nfts/mints/page.tsx',
      '/dashboard/explore/nfts/create': 'web/app/dashboard/explore/nfts/create/page.tsx',
      '/how-it-works': 'web/app/how-it-works/page.tsx',
    };
    const faqCount = FAQ.FLIZY_FAQ.length;
    for (const place of I.PLACES) {
      const [path0, hash] = place.href.split('#');
      const [route, query] = path0.split('?');
      assert.ok(pages[route], `${place.title}: no page for ${route}`);
      if (hash) {
        // An anchor must exist: a literal id on the page, or a faq answer that is really there.
        const src = read(pages[route]);
        const faq = /^faq-(\d+)$/.exec(hash);
        const ok = faq
          ? Number(faq[1]) >= 1 && Number(faq[1]) <= faqCount && /id=\{faqAnchor\(index\)\}/.test(src)
          : src.includes(`id="${hash}"`);
        assert.ok(ok, `${place.title}: ${route} has no #${hash}`);
      }
      assert.ok(pages[route], `${place.title}: no page for ${route}`);
      assert.ok(fs.existsSync(path.join(ROOT, pages[route])), `${place.title}: ${pages[route]} is missing`);
      if (query) {
        const slide = new URLSearchParams(query).get('s');
        assert.ok(slides(pages[route]).includes(slide), `${place.title}: ${route} has no slide ${slide}`);
      }
    }
  });

  it('finds help answers and links each to its own anchor', () => {
    const [first] = I.matchHelp('phone claims');
    assert.ok(first);
    assert.match(first.href, /^\/how-it-works#faq-\d+$/);
    assert.match(read('web/app/how-it-works/page.tsx'), /id=\{faqAnchor\(index\)\}/);
  });
});

describe('live search', () => {
  beforeEach(() => {
    fake = createFakeSupabase({
      accounts: [
        { id: 'acc-1', username: 'ludarep' },
        { id: 'acc-2', username: 'ludaven' },
      ],
      projects: [
        { id: 'p-1', owner_account_id: 'acc-1', handle: 'flizy', name: 'Flizy' },
        { id: 'p-2', owner_account_id: 'acc-2', handle: 'zedlabs', name: 'Zed Labs 50% off' },
      ],
      tasks: [
        { id: 't-1', ref: 142, title: 'Write a launch thread', status: 'live', ends_at: new Date(Date.now() + 3600e3).toISOString(), created_at: '2026-10-01T00:00:00.000Z' },
        { id: 't-2', ref: 143, title: 'Make your first swap', status: 'completed', ends_at: new Date(Date.now() - 3600e3).toISOString(), created_at: '2026-10-02T00:00:00.000Z' },
      ],
    });
  });

  const noNfts = async () => [];
  const run = (q, extra = {}) => S.siteSearch(q, { client: fake.client, collections: noNfts, ...extra });

  it('refuses a query too short or too long to search', async () => {
    assert.equal(await run('a'), null);
    assert.equal(await run('x'.repeat(65)), null);
    assert.equal(S.checkedSearchQuery('  fl  '), 'fl');
  });

  it('matches text literally, so 50% does not match everything', async () => {
    assert.equal(S.likePattern('50%'), '%50\\%%');
    assert.equal(S.likePattern('a_b*'), '%a\\_b%');
    const percent = await run('50%');
    assert.deepEqual(percent.projects.map((p) => p.title), ['Zed Labs 50% off']);
    const underscore = await run('l_d');
    assert.deepEqual(underscore.projects, []);
  });

  it('finds projects, tasks by title or #ref, and the listed token', async () => {
    const flizy = await run('fliz');
    assert.deepEqual(flizy.projects, [{ kind: 'project', title: 'Flizy', subtitle: 'project/flizy', href: '/project/flizy' }]);
    assert.equal(flizy.tokens[0].href, '/dashboard/explore/tokens/flz');
    const byTitle = await run('launch');
    assert.equal(byTitle.tasks[0].href, '/tasks/142');
    assert.match(byTitle.tasks[0].subtitle, /Live/);
    const byRef = await run('#143');
    assert.equal(byRef.tasks[0].title, 'Make your first swap');
    assert.match(byRef.tasks[0].subtitle, /Ended/);
  });

  it('finds a person only by the whole username', async () => {
    const exact = await run('@ludarep');
    assert.deepEqual(exact.people, [{ kind: 'person', title: '@ludarep', subtitle: 'Pay @ludarep', href: '/pay/ludarep' }]);
    assert.deepEqual((await run('@lud')).people, []);
    assert.deepEqual((await run('luda')).people, []);
  });

  it('carries no account or owner ids', async () => {
    const json = JSON.stringify(await run('fliz'));
    assert.equal(json.includes('acc-'), false);
    assert.equal(json.includes('owner'), false);
  });

  it('keeps the other groups when one source fails or hangs', async () => {
    const broken = await run('fliz', { collections: async () => { throw new Error('explorer down'); } });
    assert.deepEqual(broken.nfts, []);
    assert.equal(broken.projects.length, 1);
    const nfts = await run('apes', {
      collections: async () => [{ name: 'GIWA Apes', address: '0x' + 'ab'.repeat(20), verified: true }],
    });
    assert.equal(nfts.nfts[0].title, 'GIWA Apes');
    assert.match(nfts.nfts[0].subtitle, /^Verified/);
  });
});

describe('search wiring', () => {
  it('replaces the coming-soon buttons with real search', () => {
    for (const rel of ['web/components/AppTopBar.tsx', 'web/components/TokenDetail.tsx']) {
      const src = read(rel);
      assert.doesNotMatch(src, /comingSoon\('Search'\)/, rel);
      assert.match(src, /<SearchButton /, rel);
    }
  });

  it('serves live results only to a signed-in account, with a rate brake', () => {
    const route = read('web/app/api/search/route.ts');
    assert.match(route, /getAccountIdFromCookie\(\)/);
    assert.match(route, /status: 429/);
  });
});
