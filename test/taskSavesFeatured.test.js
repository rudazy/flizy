/**
 * Saved tasks, the Featured mark, task steps on the list, and My tasks, driven
 * through web/lib/tasks.ts the way the routes call it.
 *
 * The fake has no foreign keys and no primary keys, so the database half of
 * task_saves (one row per account and task, gone with the task) is not proven
 * here. What is proven is every decision the application makes: who may
 * feature, what a viewer is told about their own saves and nobody else's, the
 * order of steps and of the list, and the bound on saves.
 *
 * Run: node --test test/taskSavesFeatured.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

let T;
let fake;

before(async () => {
  T = await import('../web/lib/tasks.ts');
  // Cleared after the import, which repopulates them through dotenv. See
  // test/taskLifecycle.test.js for why: no test here may reach a real database.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const ADMIN = 'acc-admin';
const ALICE = 'acc-alice';
const BOB = 'acc-bob';

const c = () => fake.client;

beforeEach(() => {
  fake = createFakeSupabase(
    {
      accounts: [
        { id: ADMIN, username: 'admin1', is_admin: true },
        { id: ALICE, username: 'alice', is_admin: false },
        { id: BOB, username: 'bob', is_admin: false },
      ],
      projects: [],
      tasks: [],
      task_requirements: [],
      task_links: [],
      task_submissions: [],
      task_winners: [],
      task_saves: [],
      channel_identities: [],
      reserved_usernames: [],
    },
    { sequences: { tasks: 'ref' } }
  );
});

const future = (hours = 1) => new Date(Date.now() + hours * 3600e3).toISOString();
const savesTable = () => fake.db.tables.task_saves || [];

async function publish(by, overrides = {}) {
  return T.createTask(
    by,
    {
      title: 'Write a thread about payments',
      description: 'Explain sending money in chat.',
      rewardKind: 'crypto',
      rewardDisplay: '100 FLZ',
      winnersCount: 1,
      endsAt: future(),
      requirements: [{ kind: 'text', label: 'Say hi in a sentence' }],
      ...overrides,
    },
    c()
  );
}

describe('saving a task', () => {
  it('saves, reports the save to that viewer only, and removes it', async () => {
    const { ref } = await publish(BOB);

    assert.equal(await T.setTaskSaved(ALICE, ref, true, c()), true);
    // Saving twice keeps one row.
    assert.equal(await T.setTaskSaved(ALICE, ref, true, c()), true);
    assert.equal(savesTable().length, 1);

    const [forAlice] = await T.listTasks({ state: 'live', viewerAccountId: ALICE }, c());
    const [forBob] = await T.listTasks({ state: 'live', viewerAccountId: BOB }, c());
    const [forNobody] = await T.listTasks({ state: 'live' }, c());
    assert.equal(forAlice.saved, true);
    assert.equal(forBob.saved, false);
    assert.equal(forNobody.saved, false);

    assert.equal((await T.getTaskByRef(ref, { viewerAccountId: ALICE }, c())).saved, true);
    assert.equal((await T.getTaskByRef(ref, { viewerAccountId: null }, c())).saved, false);

    assert.equal(await T.setTaskSaved(ALICE, ref, false, c()), false);
    assert.equal(savesTable().length, 0);
  });

  it('refuses a task that does not exist, and a missing account', async () => {
    await assert.rejects(() => T.setTaskSaved(ALICE, 9999, true, c()), /Task not found/);
    await assert.rejects(() => T.setTaskSaved(ALICE, -1, true, c()), /Task not found/);
    const { ref } = await publish(BOB);
    await assert.rejects(() => T.setTaskSaved('', ref, true, c()), /Not logged in/);
    assert.equal(savesTable().length, 0);
  });

  it('bounds how many tasks one account keeps saved', async () => {
    const { ref } = await publish(BOB);
    const taskId = fake.db.tables.tasks[0].id;
    for (let i = 0; i < T.TASK_SAVES_MAX; i += 1) {
      savesTable().push({ account_id: ALICE, task_id: `other-${i}`, created_at: new Date().toISOString() });
    }
    await assert.rejects(() => T.setTaskSaved(ALICE, ref, true, c()), /Remove one to save another/);
    assert.ok(!savesTable().some((r) => r.task_id === taskId), 'the refused save was written');
    // Somebody else is not affected by Alice's count.
    assert.equal(await T.setTaskSaved(BOB, ref, true, c()), true);
  });
});

describe('featuring a task', () => {
  it('is refused for anyone but a Flizy admin, and nothing is written', async () => {
    const { ref } = await publish(ALICE);
    await assert.rejects(() => T.setTaskFeatured(ALICE, ref, true, c()), /Only Flizy admins/);
    await assert.rejects(() => T.setTaskFeatured(BOB, ref, true, c()), /Only Flizy admins/);
    assert.equal(fake.db.tables.tasks[0].featured_at ?? null, null);
  });

  it('lets an admin feature and unfeature, and lists featured tasks first', async () => {
    const soon = await publish(ALICE, { title: 'Closes first', endsAt: future(1) });
    const later = await publish(BOB, { title: 'Closes later', endsAt: future(5) });

    let list = await T.listTasks({ state: 'live' }, c());
    assert.deepEqual(list.map((t) => t.ref), [soon.ref, later.ref], 'soonest deadline first without a feature');

    assert.equal(await T.setTaskFeatured(ADMIN, later.ref, true, c()), true);
    list = await T.listTasks({ state: 'live' }, c());
    assert.deepEqual(list.map((t) => t.ref), [later.ref, soon.ref]);
    assert.equal(list[0].featured, true);
    assert.equal(list[1].featured, false);
    assert.equal((await T.getTaskByRef(later.ref, {}, c())).featured, true);

    assert.equal(await T.setTaskFeatured(ADMIN, later.ref, false, c()), false);
    list = await T.listTasks({ state: 'live' }, c());
    assert.deepEqual(list.map((t) => t.ref), [soon.ref, later.ref]);
  });

  it('tells the page whether the viewer is an admin, and nobody else', async () => {
    const { ref } = await publish(ALICE);
    assert.equal((await T.getTaskByRef(ref, { viewerAccountId: ADMIN }, c())).viewerIsAdmin, true);
    assert.equal((await T.getTaskByRef(ref, { viewerAccountId: ALICE }, c())).viewerIsAdmin, false);
    assert.equal((await T.getTaskByRef(ref, {}, c())).viewerIsAdmin, false);
  });
});

describe('steps on the list', () => {
  it('lists reference links in order, then the requirement last', async () => {
    await publish(ALICE, {
      links: [
        { kind: 'custom', label: 'Follow on X', url: 'https://x.com/flizy' },
        { kind: 'custom', label: 'Read the docs', url: 'https://example.com/docs' },
      ],
    });
    const [task] = await T.listTasks({ state: 'live' }, c());
    assert.deepEqual(task.steps, [
      { kind: 'open', label: 'Follow on X', url: 'https://x.com/flizy' },
      { kind: 'open', label: 'Read the docs', url: 'https://example.com/docs' },
      { kind: 'submit', label: 'Say hi in a sentence', requirement: 'text' },
    ]);
  });

  it('never turns a stored link that is not https into a step', async () => {
    await publish(ALICE);
    const taskId = fake.db.tables.tasks[0].id;
    fake.db.tables.task_links.push({ task_id: taskId, kind: 'custom', label: 'Bad', url: 'javascript:alert(1)', position: 0 });
    const [task] = await T.listTasks({ state: 'live' }, c());
    assert.ok(!task.steps.some((s) => s.kind === 'open'), JSON.stringify(task.steps));
  });

  it('carries the category and level on the task page', async () => {
    const { ref } = await publish(ALICE, { category: 'social', level: 'beginner' });
    const task = await T.getTaskByRef(ref, {}, c());
    assert.equal(task.category, 'social');
    assert.equal(task.level, 'beginner');
  });
});

describe('My tasks', () => {
  it('collects saved, joined and created tasks once each, with every relation', async () => {
    const mine = await publish(ALICE, { title: 'Alice made this' });
    const joined = await publish(BOB, { title: 'Bob made this' });
    const savedOnly = await publish(BOB, { title: 'Bob made this too' });
    await publish(BOB, { title: 'Nothing to do with Alice' });

    await T.submitToTask(ALICE, joined.ref, { text: 'hi there' }, c());
    await T.setTaskSaved(ALICE, joined.ref, true, c());
    await T.setTaskSaved(ALICE, savedOnly.ref, true, c());

    const list = await T.listMyTasks(ALICE, c());
    const byRef = new Map(list.map((t) => [t.ref, t]));
    assert.equal(list.length, 3);
    assert.deepEqual(byRef.get(mine.ref).relations, ['created']);
    assert.deepEqual(byRef.get(joined.ref).relations.sort(), ['joined', 'saved']);
    assert.deepEqual(byRef.get(savedOnly.ref).relations, ['saved']);
    assert.equal(byRef.get(joined.ref).saved, true);

    // The fact of an entry, never its contents.
    assert.ok(!JSON.stringify(list).includes('hi there'), 'an entry leaked into My tasks');
  });

  it('is empty for an account with nothing, and for no account', async () => {
    await publish(BOB);
    assert.deepEqual(await T.listMyTasks(ALICE, c()), []);
    assert.deepEqual(await T.listMyTasks('', c()), []);
  });
});
