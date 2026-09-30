/**
 * The guards on open task and project creation, driven through web/lib/tasks.ts.
 *
 * Creation is open to every account, so what bounds it is here: the brand-name
 * check, the per-account ceilings, the review list staying shut for a cancelled
 * task, the winner-place and reward-note checks, and the clean-up when a
 * multi-step write fails partway.
 *
 * The fake has no triggers or CHECK constraints, so the database side of these
 * rules is not proven here; this proves the application's own decisions.
 *
 * Run: node --test test/taskGuards.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

let T;
let fake;

before(async () => {
  T = await import('../web/lib/tasks.ts');
  // Cleared after the import, which repopulates them, so a call that forgets
  // the fake fails instead of reaching a real database.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const ADMIN = 'acc-admin';
const ALICE = 'acc-alice';
const BOB = 'acc-bob';

function seed(extra = {}) {
  fake = createFakeSupabase({
    accounts: [
      { id: ADMIN, username: 'staff', is_admin: true },
      { id: ALICE, username: 'alice', is_admin: false },
      { id: BOB, username: 'bob', is_admin: false },
    ],
    projects: [],
    tasks: [],
    task_requirements: [],
    task_links: [],
    task_submissions: [],
    task_winners: [],
    channel_identities: [],
    reserved_usernames: [],
    ...extra,
  }, { sequences: { tasks: 'ref' } });
}

const c = () => fake.client;
const future = () => new Date(Date.now() + 3600e3).toISOString();
const nowIso = () => new Date().toISOString();
const table = (name) => fake.db.tables[name] || [];

function publish(accountId, overrides = {}, client = c()) {
  return T.createTask(accountId, {
    title: 'Write a thread about wallets',
    description: 'Explain it plainly.',
    rewardKind: 'custom',
    rewardDisplay: '10 WL spots',
    winnersCount: 2,
    endsAt: future(),
    requirements: [{ kind: 'x_post', label: 'Submit the post URL' }],
    ...overrides,
  }, client);
}

/**
 * The fake client with one table's writes answering with an error. `op` is the
 * builder method to fail, and `nth` which call of it (1-based), so a rollback
 * can be failed while the write before it succeeds.
 */
function failing(tableName, op, nth = 1) {
  let calls = 0;
  const base = fake.client;
  const failed = {
    eq() { return failed; },
    select() { return failed; },
    then(resolve) { resolve({ data: null, error: { message: `${tableName} ${op} refused` } }); },
  };
  return {
    rpc: base.rpc.bind(base),
    from(t) {
      const q = base.from(t);
      if (t !== tableName) return q;
      const real = q[op].bind(q);
      q[op] = (...args) => {
        calls += 1;
        return calls === nth ? failed : real(...args);
      };
      return q;
    },
  };
}

function closeTask(ref) {
  table('tasks').find((t) => t.ref === ref).ends_at = new Date(Date.now() - 60e3).toISOString();
}

describe('the Flizy name', () => {
  beforeEach(seed);

  it('refuses a task title using it, however it is spelled', async () => {
    for (const title of ['Official Flizy airdrop', 'FLIZY rewards', 'The F.l.i.z.z.y drop']) {
      await assert.rejects(() => publish(ALICE, { title }), /Flizy name/, title);
    }
    assert.equal(table('tasks').length, 0);
  });

  it('refuses a project name or handle using it', async () => {
    await assert.rejects(
      () => T.createProject(ALICE, { name: 'Flizy Team', handle: 'teamone' }, c()),
      /Flizy name/
    );
    await assert.rejects(
      () => T.createProject(ALICE, { name: 'Team One', handle: 'flizyteam' }, c()),
      /Flizy name/
    );
    assert.equal(table('projects').length, 0);
  });

  it('lets an admin use it', async () => {
    await publish(ADMIN, { title: 'Official Flizy airdrop' });
    await T.createProject(ADMIN, { name: 'Flizy', handle: 'flizyhq' }, c());
    assert.equal(table('tasks').length, 1);
    assert.equal(table('projects').length, 1);
  });
});

describe('per-account ceilings', () => {
  beforeEach(seed);

  it('caps projects per account', async () => {
    for (let i = 0; i < T.MAX_PROJECTS_PER_ACCOUNT; i += 1) {
      await T.createProject(ALICE, { name: `Project ${i}`, handle: `proj${i}x` }, c());
    }
    await assert.rejects(
      () => T.createProject(ALICE, { name: 'One more', handle: 'onemore' }, c()),
      /can have 5 projects/
    );
    await T.createProject(BOB, { name: 'Bobs', handle: 'bobsproj' }, c());
  });

  it('caps live tasks per account', async () => {
    fake.db.tables.tasks = Array.from({ length: T.MAX_LIVE_TASKS_PER_ACCOUNT }, (_, i) => ({
      id: `old-${i}`,
      ref: 10 + i,
      creator_account_id: ALICE,
      status: 'live',
      ends_at: future(),
      // Old enough to be outside the daily window, so only the live cap applies.
      created_at: new Date(Date.now() - 3 * 86400e3).toISOString(),
    }));
    await assert.rejects(() => publish(ALICE), /10 live tasks/);
    await publish(BOB);
  });

  it('does not count closed or decided tasks as live', async () => {
    fake.db.tables.tasks = Array.from({ length: T.MAX_LIVE_TASKS_PER_ACCOUNT }, (_, i) => ({
      id: `old-${i}`,
      ref: 10 + i,
      creator_account_id: ALICE,
      status: i % 2 ? 'cancelled' : 'live',
      ends_at: new Date(Date.now() - 60e3).toISOString(),
      created_at: new Date(Date.now() - 3 * 86400e3).toISOString(),
    }));
    await publish(ALICE);
  });

  it('caps tasks created per rolling day', async () => {
    fake.db.tables.tasks = Array.from({ length: T.MAX_TASKS_PER_ACCOUNT_PER_DAY }, (_, i) => ({
      id: `old-${i}`,
      ref: 10 + i,
      creator_account_id: ALICE,
      status: 'cancelled',
      cancelled_at: nowIso(),
      ends_at: future(),
      created_at: nowIso(),
    }));
    await assert.rejects(() => publish(ALICE), /10 tasks a day/);

    for (const row of fake.db.tables.tasks) {
      row.created_at = new Date(Date.now() - 25 * 3600e3).toISOString();
    }
    await publish(ALICE);
  });

  it('caps submissions per rolling hour', async () => {
    const { ref } = await publish(ADMIN);
    fake.db.tables.task_submissions = Array.from(
      { length: T.MAX_SUBMISSIONS_PER_ACCOUNT_PER_HOUR },
      (_, i) => ({ id: `s-${i}`, task_id: `elsewhere-${i}`, ref: 1, account_id: ALICE, created_at: nowIso() })
    );
    await assert.rejects(
      () => T.submitToTask(ALICE, ref, { url: 'https://x.com/alice/status/1234567890' }, c()),
      /last hour/
    );

    for (const row of fake.db.tables.task_submissions) {
      row.created_at = new Date(Date.now() - 2 * 3600e3).toISOString();
    }
    const entered = await T.submitToTask(ALICE, ref, { url: 'https://x.com/alice/status/1234567890' }, c());
    assert.equal(entered.submissionRef, 1);
  });

  it('takes exactly one requirement', async () => {
    await assert.rejects(
      () =>
        publish(ALICE, {
          requirements: [
            { kind: 'text', label: 'Say something' },
            { kind: 'x_post', label: 'And post it' },
          ],
        }),
      /exactly one/
    );
  });
});

describe('a cancelled task', () => {
  beforeEach(seed);

  it('never hands its entries to the creator', async () => {
    const { ref } = await publish(ADMIN);
    await T.submitToTask(ALICE, ref, { url: 'https://x.com/alice/status/1234567890' }, c());
    await T.cancelTask(ADMIN, ref, c());

    await assert.rejects(() => T.listSubmissionsForCreator(ADMIN, ref, c()), /cancelled/);
    closeTask(ref);
    await assert.rejects(() => T.listSubmissionsForCreator(ADMIN, ref, c()), /cancelled/);
  });
});

describe('choosing winners', () => {
  beforeEach(seed);

  async function closedWithTwoEntries() {
    const { ref } = await publish(ADMIN);
    await T.submitToTask(ALICE, ref, { url: 'https://x.com/alice/status/1234567890' }, c());
    await T.submitToTask(BOB, ref, { url: 'https://x.com/bob/status/2222222222' }, c());
    closeTask(ref);
    const { submissions } = await T.listSubmissionsForCreator(ADMIN, ref, c());
    return { ref, submissions };
  }

  it('refuses a place outside 1..winners_count or not a whole number', async () => {
    const { ref, submissions } = await closedWithTwoEntries();
    for (const place of [0, 3, -1, 1.5, Number.NaN]) {
      await assert.rejects(
        () => T.finalizeWinners(ADMIN, ref, [{ submissionId: submissions[0].id, place }], c()),
        /Places run from 1 to 2/,
        String(place)
      );
    }
    assert.equal(table('task_winners').length, 0);
    assert.equal(table('tasks')[0].status, 'live');
  });

  it('refuses one entry winning twice', async () => {
    const { ref, submissions } = await closedWithTwoEntries();
    await assert.rejects(
      () =>
        T.finalizeWinners(ADMIN, ref, [
          { submissionId: submissions[0].id, place: 1 },
          { submissionId: submissions[0].id, place: 2 },
        ], c()),
      /cannot win twice/
    );
  });

  it('caps the reward note at 120 characters, trimmed', async () => {
    const { ref, submissions } = await closedWithTwoEntries();
    await assert.rejects(
      () =>
        T.finalizeWinners(ADMIN, ref, [
          { submissionId: submissions[0].id, place: 1, rewardNote: 'x'.repeat(T.REWARD_NOTE_MAX + 1) },
        ], c()),
      /120 characters/
    );

    const padded = `  ${'y'.repeat(T.REWARD_NOTE_MAX)}  `;
    await T.finalizeWinners(ADMIN, ref, [{ submissionId: submissions[0].id, place: 1, rewardNote: padded }], c());
    assert.equal(table('task_winners')[0].reward_note.length, T.REWARD_NOTE_MAX);
  });

  it('reopens the task when saving the winners fails', async () => {
    const { ref, submissions } = await closedWithTwoEntries();
    await assert.rejects(
      () =>
        T.finalizeWinners(ADMIN, ref, [{ submissionId: submissions[0].id, place: 1 }], failing('task_winners', 'insert')),
      /task_winners insert refused/
    );
    assert.equal(table('tasks')[0].status, 'live');
    assert.equal(table('tasks')[0].completed_at, null);
  });

  it('says so loudly when the task cannot be reopened either', async () => {
    const { ref, submissions } = await closedWithTwoEntries();
    const client = failing('task_winners', 'insert');
    // The second update on tasks is the reopen; the first is taking the task.
    const reopenFails = failing('tasks', 'update', 2);
    const both = {
      rpc: client.rpc,
      from: (t) => (t === 'tasks' ? reopenFails.from(t) : client.from(t)),
    };

    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    try {
      await assert.rejects(
        () => T.finalizeWinners(ADMIN, ref, [{ submissionId: submissions[0].id, place: 1 }], both),
        /completed with no winners/
      );
    } finally {
      console.error = originalError;
    }
    assert.ok(logged.some((l) => l.includes('completed with no winners')));
  });
});

describe('publishing fails closed', () => {
  beforeEach(seed);

  it('removes the task when its requirement cannot be saved', async () => {
    await assert.rejects(
      () => publish(ALICE, {}, failing('task_requirements', 'insert')),
      /task_requirements insert refused/
    );
    assert.equal(table('tasks').length, 0, 'no live task is left without its requirement');
  });

  it('removes the task when its links cannot be saved', async () => {
    await assert.rejects(
      () =>
        publish(ALICE, { links: [{ kind: 'website', label: 'Site', url: 'https://ok.test' }] }, failing('task_links', 'insert')),
      /task_links insert refused/
    );
    assert.equal(table('tasks').length, 0);
  });
});

describe('usernames and project handles', () => {
  beforeEach(seed);

  it('reports a handle held by a project, in any case', async () => {
    await T.createProject(ALICE, { name: 'Team One', handle: 'teamone' }, c());
    assert.equal(await T.isHandleTakenByProject('teamone', c()), true);
    assert.equal(await T.isHandleTakenByProject('@TeamOne', c()), true);
    assert.equal(await T.isHandleTakenByProject('teamtwo', c()), false);
  });
});
