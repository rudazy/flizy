/**
 * The project page data and its labels, driven through web/lib/tasks.ts: the
 * banner check, task category and level, and the four figures at the top of
 * the page, with what the public page may and may not carry. Plus source
 * checks on the shared ProjectPage component.
 *
 * Run: node --test test/projectPage.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

let T;
let fake;

before(async () => {
  T = await import('../web/lib/tasks.ts');
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const OWNER = 'acc-owner';
const ANN = 'acc-ann';
const BEN = 'acc-ben';
const PROJECT = 'p-1';

const future = () => new Date(Date.now() + 3600e3).toISOString();
const past = () => new Date(Date.now() - 3600e3).toISOString();
const dataUrl = (kind, bytes) => `data:image/${kind};base64,${Buffer.from(bytes).toString('base64')}`;
const WEBP = dataUrl('webp', [...Buffer.from('RIFF'), 20, 0, 0, 0, ...Buffer.from('WEBPVP8 '), 1, 2]);

function seed() {
  fake = createFakeSupabase(
    {
      accounts: [
        { id: OWNER, username: 'owner' },
        { id: ANN, username: 'ann' },
        { id: BEN, username: 'ben' },
      ],
      projects: [
        { id: PROJECT, owner_account_id: OWNER, handle: 'teamone', name: 'Team One', description: '', links: [], banner: WEBP, created_at: '2026-10-01T00:00:00.000Z' },
      ],
      project_members: [],
      tasks: [],
      task_requirements: [],
      task_links: [],
      task_submissions: [],
      task_winners: [],
      channel_identities: [],
      reserved_usernames: [],
    },
    { sequences: { tasks: 'ref' } }
  );
}

const c = () => fake.client;

function publish(overrides = {}) {
  return T.createTask(
    OWNER,
    {
      title: 'Write a thread about wallets',
      description: 'Explain it plainly, in your own words, for someone who has never used a wallet before.',
      rewardKind: 'custom',
      rewardDisplay: '10 WL spots',
      winnersCount: 2,
      endsAt: future(),
      projectId: PROJECT,
      category: 'social',
      level: 'beginner',
      requirements: [{ kind: 'x_post', label: 'Submit the post URL' }],
      ...overrides,
    },
    c()
  );
}

describe('task category and level', () => {
  beforeEach(seed);

  it('are stored and come back on the list rows', async () => {
    await publish();
    const page = await T.getPublicProject('teamone', c());
    assert.equal(page.tasks[0].category, 'social');
    assert.equal(page.tasks[0].level, 'beginner');
    assert.match(page.tasks[0].description, /^Explain it plainly/);
  });

  it('are optional, and refused when not one of the listed values', async () => {
    await publish({ category: null, level: undefined });
    assert.equal(fake.db.tables.tasks[0].category, null);
    await assert.rejects(() => publish({ category: 'gaming' }), { message: 'Pick a category from the list.' });
    await assert.rejects(() => publish({ level: 'expert' }), { message: 'Pick a level from the list.' });
  });

  it('drops an unknown stored value instead of showing it', async () => {
    await publish();
    fake.db.tables.tasks[0].category = 'something-else';
    const page = await T.getPublicProject('teamone', c());
    assert.equal(page.tasks[0].category, null);
  });

  it('keeps a long description short on the list row', async () => {
    await publish({ description: 'x'.repeat(500) });
    const page = await T.getPublicProject('teamone', c());
    assert.equal(page.tasks[0].description.length, 140);
  });
});

describe('project banner', () => {
  beforeEach(seed);

  it('accepts a wide image the picture limit would refuse, up to its own limit', () => {
    const wide = `data:image/webp;base64,${Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(160000)]).toString('base64')}`;
    assert.ok(wide.length > T.PROJECT_IMAGE_MAX_CHARS && wide.length <= T.PROJECT_BANNER_MAX_CHARS);
    assert.equal(T.checkedProjectBanner(wide), wide);
    assert.throws(() => T.checkedProjectImage(wide), /too large/);
    assert.throws(() => T.checkedProjectBanner(`data:image/png;base64,${'A'.repeat(T.PROJECT_BANNER_MAX_CHARS)}`), /too large/);
    assert.throws(() => T.checkedProjectBanner('data:image/svg+xml;base64,PHN2Zz4='), /PNG, JPEG or WebP/);
  });

  it('is saved on create and edit, removed with null, and shown on the page', async () => {
    const made = await T.createProject(OWNER, { handle: 'teamtwo', name: 'Team Two', banner: WEBP }, c());
    assert.ok(made.id);
    assert.equal(fake.db.tables.projects[1].banner, WEBP);
    const saved = await T.updateProject(OWNER, 'teamone', { banner: null }, c());
    assert.equal(saved.banner, null);
    assert.equal(fake.db.tables.projects[0].banner, null);
    const again = await T.updateProject(OWNER, 'teamone', { banner: WEBP }, c());
    assert.equal(again.banner, WEBP);
    assert.equal((await T.getPublicProject('teamone', c())).banner, WEBP);
  });

  it('is not sent with the project list, which stays small', async () => {
    const [row] = await T.listOwnProjects(OWNER, c());
    assert.equal(Object.hasOwn(row, 'banner'), false);
  });
});

describe('the four figures', () => {
  beforeEach(seed);

  it('count distinct entrants, live and ended tasks, and XP', async () => {
    const a = await publish();
    const b = await publish({ title: 'Make your first swap', category: 'onchain' });
    await T.submitToTask(ANN, a.ref, { url: 'https://x.com/ann/status/1111111111' }, c());
    await T.submitToTask(BEN, a.ref, { url: 'https://x.com/ben/status/2222222222' }, c());
    await T.submitToTask(ANN, b.ref, { url: 'https://x.com/ann/status/3333333333' }, c());
    fake.db.tables.tasks.find((t) => t.ref === b.ref).ends_at = past();

    const { stats } = await T.getPublicProject('teamone', c());
    assert.equal(stats.participants, 2, 'ann entered twice and counts once');
    assert.equal(stats.liveTasks, 1);
    assert.equal(stats.endedTasks, 1);
    assert.equal(stats.totalTasks, 2);
    assert.deepEqual([...stats.recentInitials].sort(), ['A', 'B']);
    assert.deepEqual(stats.rewardsPaid, []);
    assert.equal(stats.xpTotal, 0);

    const ws = await T.getProjectWorkspace(OWNER, 'teamone', c());
    assert.deepEqual(ws.stats, stats);
    assert.equal(ws.banner, WEBP);
    assert.equal(ws.createdAt, '2026-10-01T00:00:00.000Z');
  });

  it('give the public page letters, not who the entrants are', async () => {
    const a = await publish();
    await T.submitToTask(ANN, a.ref, { url: 'https://x.com/ann/status/1111111111' }, c());
    const page = await T.getPublicProject('teamone', c());
    const json = JSON.stringify(page);
    assert.equal(json.includes(ANN), false, 'no account id');
    assert.equal(json.includes(OWNER), false, 'no owner id');
    assert.equal(json.includes('"ann"'), false, 'no entrant username outside a win');
    assert.equal(Object.hasOwn(page, 'members'), false);
    assert.equal(Object.hasOwn(page, 'id'), false);
  });
});

describe('the shared project page', () => {
  const ROOT = path.join(__dirname, '..');
  const page = fs.readFileSync(path.join(ROOT, 'web/components/ProjectPage.tsx'), 'utf8');

  it('uses no blue', () => {
    assert.doesNotMatch(page, /\b(?:text|bg|border|ring|from|to|via)-(?:blue|sky|cyan|indigo|teal)-/);
  });

  it('shares with the phone share sheet and falls back to copying the link', () => {
    assert.match(page, /typeof nav\.share === 'function'/);
    assert.match(page, /await copy\('share'\)/);
  });

  it('offers Manage on the public page only to the team, and edit tools only in the workspace', () => {
    assert.match(page, /\) : isTeam \? \(\s*<Link href=\{`\/dashboard\/projects\//);
    assert.match(page, /\{mode === 'workspace' \? \(\s*<div className="relative" ref=\{menuRef\}>/);
  });

  it('is the page for both the workspace and the public project page', () => {
    assert.match(fs.readFileSync(path.join(ROOT, 'web/components/ProjectWorkspace.tsx'), 'utf8'), /<ProjectPage\s+mode="workspace"/);
    assert.match(fs.readFileSync(path.join(ROOT, 'web/app/project/[handle]/page.tsx'), 'utf8'), /<ProjectPage\s+mode="public"/);
  });
});
