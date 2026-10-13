/**
 * Dashboard background uploads stay on the signed-in account.
 *
 * Run: node --test test/accountBackground.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const OWNER = 'acc-owner';
const OTHER = 'acc-other';

function webp(size = 64) {
  const bytes = Buffer.alloc(size);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(size - 8, 4);
  bytes.write('WEBP', 8);
  return bytes;
}

function harness() {
  const { client, db } = createFakeSupabase();
  const files = new Map();
  const removed = [];
  const buckets = [];
  client.storage = {
    from(bucket) {
      buckets.push(bucket);
      return {
        async upload(objectPath, bytes, opts) {
          files.set(objectPath, { bytes: Buffer.from(bytes), type: opts.contentType });
          return { data: { path: objectPath }, error: null };
        },
        async remove(paths) {
          for (const objectPath of paths) {
            removed.push(objectPath);
            files.delete(objectPath);
          }
          return { data: null, error: null };
        },
        async download(objectPath) {
          const hit = files.get(objectPath);
          if (!hit) return { data: null, error: { message: 'Object not found' } };
          return { data: new Blob([hit.bytes]), error: null };
        },
      };
    },
  };
  let n = 0;
  const deps = {
    supabase: client,
    now: Date.UTC(2026, 9, 13, 12, 0, 0),
    randomId: () => {
      n += 1;
      return n.toString(16).padStart(32, 'a');
    },
  };
  const hits = new Map();
  client.rpc = async (name, args) => {
    if (name !== 'claim_background_upload') {
      return { data: null, error: { message: `unknown function ${name}` } };
    }
    const accountId = args && args.p_account_id;
    if (!accountId) return { data: false, error: null };
    const now = deps.now ?? Date.now();
    const kept = (hits.get(accountId) || []).filter((ts) => now - ts < 60 * 60 * 1000);
    if (kept.length >= 8) {
      hits.set(accountId, kept);
      return { data: false, error: null };
    }
    kept.push(now);
    hits.set(accountId, kept);
    return { data: true, error: null };
  };
  return { deps, files, removed, buckets, db };
}

describe('background upload', () => {
  it('rejects no session, a non-image, SVG and an oversize file, and accepts WebP', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps, files, buckets } = harness();

    const signedOut = await api.uploadBackground(deps, null, webp());
    assert.equal(signedOut.status, 401);

    const gif = Buffer.from('GIF89a');
    const wrong = await api.uploadBackground(deps, OWNER, gif);
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /WebP, JPEG or PNG/);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const drawn = await api.uploadBackground(deps, OWNER, svg);
    assert.equal(drawn.status, 400);

    const huge = webp(Math.floor(1.5 * 1024 * 1024) + 1);
    const over = await api.uploadBackground(deps, OWNER, huge);
    assert.equal(over.status, 400);
    assert.match(over.body.error, /too large/);

    const ok = await api.uploadBackground(deps, OWNER, webp(), '60');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.appearance.mode, 'image');
    assert.equal(ok.body.appearance.dim, 60);
    assert.equal(ok.body.appearance.preset, null);
    assert.equal(JSON.stringify(ok.body).includes(OWNER), false);
    assert.equal(JSON.stringify(ok.body).includes('image_path'), false);
    assert.equal(files.size, 1);
    const stored = [...files.keys()][0];
    assert.match(stored, /^[a-f0-9]{32}\.webp$/);
    assert.equal(stored.includes(OWNER), false);
    assert.deepEqual([...new Set(buckets)], ['user-backgrounds']);
  });

  it('stops after eight uploads in an hour and does not store the ninth', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps, files } = harness();
    for (let i = 0; i < 8; i += 1) {
      const result = await api.uploadBackground(deps, OWNER, webp());
      assert.equal(result.status, 200);
    }
    assert.equal(files.size, 1);
    const blocked = await api.uploadBackground(deps, OWNER, webp());
    assert.equal(blocked.status, 429);
    assert.equal(files.size, 1);

    deps.now += 61 * 60 * 1000;
    const later = await api.uploadBackground(deps, OWNER, webp());
    assert.equal(later.status, 200);
  });

  it('does not spend a slot on a file it will refuse', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps, files } = harness();
    for (let i = 0; i < 8; i += 1) {
      const refused = await api.uploadBackground(deps, OWNER, Buffer.from('<svg></svg>'));
      assert.equal(refused.status, 400);
    }
    const ok = await api.uploadBackground(deps, OWNER, webp());
    assert.equal(ok.status, 200);
    assert.equal(files.size, 1);
  });

  it('refuses a path that is the account id and stores nothing', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps, files } = harness();
    const accountId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    deps.randomId = () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = await api.uploadBackground(deps, accountId, webp());
    assert.equal(result.status, 500);
    assert.equal(result.body.error.includes(accountId), false);
    assert.equal(files.size, 0);
  });

  it('still counts a slot when the store rejects the file', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps, files } = harness();
    const realFrom = deps.supabase.storage.from.bind(deps.supabase.storage);
    let fail = true;
    deps.supabase.storage.from = (bucket) => {
      const bucketApi = realFrom(bucket);
      const upload = bucketApi.upload.bind(bucketApi);
      bucketApi.upload = async (...args) => {
        if (fail) return { data: null, error: { message: 'store failed' } };
        return upload(...args);
      };
      return bucketApi;
    };
    const denied = await api.uploadBackground(deps, OWNER, webp());
    assert.equal(denied.status, 500);
    assert.equal(denied.body.error, 'Something went wrong. Please try again.');
    assert.equal(files.size, 0);
    fail = false;
    for (let i = 0; i < 7; i += 1) {
      const result = await api.uploadBackground(deps, OWNER, webp());
      assert.equal(result.status, 200);
    }
    const blocked = await api.uploadBackground(deps, OWNER, webp());
    assert.equal(blocked.status, 429);
  });

  it('removes a file whose path did not stay on the row', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps, files, removed, db } = harness();
    const realFrom = deps.supabase.from.bind(deps.supabase);
    let selects = 0;
    deps.supabase.from = (table) => {
      const query = realFrom(table);
      if (table !== 'account_appearance') return query;
      const realSelect = query.select.bind(query);
      query.select = (cols, opts) => {
        selects += 1;
        if (selects === 2) {
          const stored = (db.tables.account_appearance || [])[0];
          if (stored) stored.image_path = 'b'.repeat(32) + '.webp';
        }
        return realSelect(cols, opts);
      };
      return query;
    };
    const result = await api.uploadBackground(deps, OWNER, webp());
    assert.equal(result.status, 200);
    assert.equal(result.body.appearance.mode, 'image');
    assert.equal(files.size, 0);
    assert.equal(removed.length, 1);
  });
});

describe('background image route', () => {
  it('gives the file to the owner and 404 to another account', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps } = harness();
    const saved = await api.uploadBackground(deps, OWNER, webp());
    assert.equal(saved.status, 200);

    const owner = await api.readBackgroundImage(deps, OWNER);
    assert.equal(owner.status, 200);
    assert.equal(owner.contentType, 'image/webp');
    assert.equal(Buffer.from(owner.bytes).slice(0, 4).toString(), 'RIFF');

    const other = await api.readBackgroundImage(deps, OTHER);
    assert.equal(other.status, 404);

    const signedOut = await api.readBackgroundImage(deps, null);
    assert.equal(signedOut.status, 401);
  });

  it('deletes the old file when the image is replaced or reset', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps, files, removed } = harness();
    await api.uploadBackground(deps, OWNER, webp());
    const first = [...files.keys()][0];
    await api.uploadBackground(deps, OWNER, webp());
    const second = [...files.keys()][0];
    assert.notEqual(first, second);
    assert.deepEqual(removed, [first]);
    assert.equal(files.has(first), false);

    const reset = await api.setAppearanceChoice(deps, OWNER, { mode: 'default' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.appearance.mode, 'default');
    assert.equal(reset.body.appearance.version, 2);
    assert.deepEqual(removed, [first, second]);
    assert.equal(files.size, 0);

    const gone = await api.readBackgroundImage(deps, OWNER);
    assert.equal(gone.status, 404);

    const again = await api.uploadBackground(deps, OWNER, webp());
    assert.equal(again.status, 200);
    assert.equal(again.body.appearance.version, 3);
  });

  it('switches to a preset and deletes the uploaded file', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps, files, removed } = harness();
    await api.uploadBackground(deps, OWNER, webp());
    const first = [...files.keys()][0];
    const result = await api.setAppearanceChoice(deps, OWNER, { mode: 'preset', preset: 'gold' });
    assert.equal(result.status, 200);
    assert.equal(result.body.appearance.mode, 'preset');
    assert.equal(result.body.appearance.preset, 'gold');
    assert.equal(files.has(first), false);
    assert.deepEqual(removed, [first]);
  });

  it('changes the dim of the current image and leaves the file', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps, files, removed } = harness();
    await api.uploadBackground(deps, OWNER, webp());
    const result = await api.setAppearanceChoice(deps, OWNER, { mode: 'image', dim: 12 });
    assert.equal(result.status, 200);
    assert.equal(result.body.appearance.mode, 'image');
    assert.equal(result.body.appearance.dim, 12);
    assert.equal(files.size, 1);
    assert.equal(removed.length, 0);
  });

  it('keeps a newer file when a preset write loses the race', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps, files, removed, db } = harness();
    await api.uploadBackground(deps, OWNER, webp());
    const kept = 'b'.repeat(32) + '.webp';
    const realFrom = deps.supabase.from.bind(deps.supabase);
    deps.supabase.from = (table) => {
      const query = realFrom(table);
      if (table !== 'account_appearance') return query;
      const realUpdate = query.update.bind(query);
      query.update = (payload) => {
        if (payload && payload.mode === 'preset') {
          const stored = (db.tables.account_appearance || [])[0];
          if (stored) stored.image_path = kept;
        }
        return realUpdate(payload);
      };
      return query;
    };
    const result = await api.setAppearanceChoice(deps, OWNER, { mode: 'preset', preset: 'wine' });
    assert.equal(result.status, 200);
    assert.equal(result.body.appearance.mode, 'image');
    assert.equal(removed.length, 0);
    assert.equal(files.size, 1);
  });

  it('leaves the new file in place when a dim write loses the race', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps, files, removed, db } = harness();
    await api.uploadBackground(deps, OWNER, webp());
    const kept = 'c'.repeat(32) + '.webp';
    const realFrom = deps.supabase.from.bind(deps.supabase);
    deps.supabase.from = (table) => {
      const query = realFrom(table);
      if (table !== 'account_appearance') return query;
      const realUpdate = query.update.bind(query);
      query.update = (payload) => {
        if (payload && payload.mode === 'image') {
          const stored = (db.tables.account_appearance || [])[0];
          if (stored) stored.image_path = kept;
        }
        return realUpdate(payload);
      };
      return query;
    };
    const result = await api.setAppearanceChoice(deps, OWNER, { mode: 'image', dim: 12 });
    assert.equal(result.status, 200);
    assert.equal(result.body.appearance.mode, 'image');
    assert.equal(result.body.appearance.dim, 60);
    assert.equal(removed.length, 0);
    assert.equal(files.size, 1);
  });

  it('does not overwrite a row that appears before the first preset insert', async () => {
    const api = await import('../web/lib/accountBackground.ts');
    const { deps, db } = harness();
    const realFrom = deps.supabase.from.bind(deps.supabase);
    deps.supabase.from = (table) => {
      const query = realFrom(table);
      if (table !== 'account_appearance') return query;
      query.insert = () => ({
        then(resolve) {
          db.tables.account_appearance = [
            {
              account_id: OWNER,
              mode: 'image',
              preset: null,
              image_path: 'd'.repeat(32) + '.webp',
              dim: 40,
              version: 4,
            },
          ];
          resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
        },
      });
      return query;
    };
    const result = await api.setAppearanceChoice(deps, OWNER, { mode: 'preset', preset: 'wine' });
    assert.equal(result.status, 200);
    assert.equal(result.body.appearance.mode, 'image');
    assert.equal(result.body.appearance.version, 4);
    assert.equal(result.body.appearance.dim, 40);
  });
});

describe('background shell', () => {
  const root = path.join(__dirname, '..', 'web');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

  it('paints the background as a sibling of the shell, not a wrapper', () => {
    const layout = read('app/dashboard/layout.tsx');
    const gate = read('components/DashboardGate.tsx');
    const css = read('app/globals.css');
    assert.match(layout, /id="flizy-app-bg"/);
    assert.match(layout, /APPEARANCE_BOOT_SCRIPT/);
    assert.match(css, /\.app-bg \{[^}]*position:\s*fixed/s);
    assert.doesNotMatch(gate, /flizy-app-bg/);
    assert.match(gate, /className="app-shell app-shell-tabbed"/);
    const bgAt = layout.indexOf('flizy-app-bg');
    const gateAt = layout.indexOf('<DashboardGate');
    assert.ok(bgAt !== -1 && gateAt > bgAt);
  });

  it('allowlists presets by equality and keeps the upload claim in SQL', () => {
    const cache = read('lib/appearanceCache.ts');
    assert.match(cache, /allowed\[i\]===a\.preset/);
    assert.doesNotMatch(cache, /ok\[a\.preset\]/);
    assert.doesNotMatch(cache, /appearancePresetIds/);
    assert.match(cache, /isAppearancePreset\(value\.preset\)/);

    const imageRoute = read('app/api/account/background/image/route.ts');
    assert.match(imageRoute, /file\.size > BACKGROUND_MAX_BYTES/);
    assert.match(imageRoute, /'Vary': 'Cookie'/);

    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', 'api', 'dashboard', 'route.ts'), 'utf8');
    assert.match(dashboard, /logApiError\(ROUTE, err, \{ step: 'appearance' \}\)/);
    assert.doesNotMatch(dashboard, /console\.warn\('\[dashboard\] appearance'/);

    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'supabase', 'migrations', '20261015130000_account_background_uploads.sql'),
      'utf8'
    );
    assert.match(sql, /security definer/);
    assert.match(sql, /set search_path = public/);
    assert.match(sql, />= 8/);
    assert.match(sql, /interval '1 hour'/);
    assert.match(sql, /revoke all on function public\.claim_background_upload\(uuid\) from public, anon, authenticated/);
    assert.match(sql, /enable row level security/);
    assert.match(read('lib/accountBackground.ts'), /from\('account_background_uploads'\)/);
    assert.match(read('lib/accountBackground.ts'), /rpc\('claim_background_upload'/);
  });

  it('puts the control on the profile slide', () => {
    const profile = read('components/AccountProfile.tsx');
    assert.match(profile, /<AccountBackground \/>/);
    const background = read('components/AccountBackground.tsx');
    assert.match(background, /<details/);
    assert.match(background, /<summary/);
    const info = profile.indexOf('Account Information');
    const backgroundAt = profile.indexOf('<AccountBackground />');
    const wallet = profile.indexOf('Flizy Wallet');
    assert.ok(info !== -1 && backgroundAt > info && wallet > backgroundAt);
  });
});
