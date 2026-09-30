/**
 * A task from publish to winners, driven through the module the routes call.
 *
 * Driven through `web/lib/tasks.ts` rather than by poking rows, for the reason
 * test/billLifecycle.test.js gives: a pure function can be correct while the
 * caller feeds it the wrong shape, and the caller is the part that ships.
 *
 * What this file can and cannot prove is worth stating, because the gap is where
 * the real risk lives. The fake has no triggers, no CHECK constraints and no
 * unique indexes, so the deadline trigger and the two uniqueness rules are NOT
 * proven here. They were proven against the dev database directly. What is
 * proven here is every decision the application makes on its own: who may act,
 * what is refused, and what the public sees at each stage.
 *
 * Run: node --test test/taskLifecycle.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');


let T;
let fake;

before(async () => {
  T = await import('../web/lib/tasks.ts');

  // No test in this file may reach a real database, and the env has to be
  // cleared HERE rather than at the top: web/lib/supabase.ts calls dotenv at
  // import time and repopulates whatever was deleted earlier. getSupabase()
  // reads these lazily and throws without them, so a call site that forgets to
  // pass the fake fails loudly instead of quietly opening a client against the
  // nearest .env. Clearing them above the import would do nothing, because the
  // import puts them back.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const CREATOR = 'acc-creator';
const ALICE = 'acc-alice';
const BOB = 'acc-bob';

/**
 * The module takes its client as an optional last argument, the way
 * web/lib/channelBind.ts does, so the fake goes in without touching env or the
 * module cache. `c()` is that argument.
 */
const c = () => fake.client;

function seed(extra = {}) {
  fake = createFakeSupabase({
    accounts: [
      { id: CREATOR, username: 'creator', is_admin: true },
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
    reserved_usernames: [{ normalized_name: 'admin' }],
    ...extra,
  }, { sequences: { tasks: 'ref' } });
}

const future = () => new Date(Date.now() + 3600e3).toISOString();
const tasksTable = () => fake.db.tables.tasks || [];
const subsTable = () => fake.db.tables.task_submissions || [];
const winnersTable = () => fake.db.tables.task_winners || [];

/** Move a task's deadline into the past, the way time would. */
function closeTask(ref) {
  const row = tasksTable().find((t) => t.ref === ref);
  row.ends_at = new Date(Date.now() - 60e3).toISOString();
}

async function publish(overrides = {}) {
  return T.createTask(CREATOR, {
    title: 'Create an X post about Flizy',
    description: 'Explain what Flizy does.',
    rewardKind: 'crypto',
    rewardDisplay: '$100 USDC',
    winnersCount: 2,
    endsAt: future(),
    requirements: [{ kind: 'x_post', label: 'Submit the post URL' }],
    ...overrides,
  }, c());
}

describe('publishing', () => {
  beforeEach(seed);

  it('creates a live task with a ref and its requirement', async () => {
    const { ref } = await publish();

    assert.ok(Number.isInteger(ref));
    const row = tasksTable()[0];
    assert.equal(row.status, 'live');
    assert.equal(row.creator_account_id, CREATOR);
    assert.equal((fake.db.tables.task_requirements || []).length, 1);
  });

  it('refuses the shapes that would make a task meaningless', async () => {
    const cases = [
      [{ title: 'no' }, /3 to 140/],
      [{ endsAt: new Date(Date.now() - 1000).toISOString() }, /future/i],
      [{ requirements: [] }, /requirement/i],
      [{ winnersCount: 0 }, /1 to 100/],
      [{ rewardDisplay: '' }, /reward/i],
      [{ rewardKind: 'vibes' }, /reward type/i],
    ];
    for (const [override, expected] of cases) {
      await assert.rejects(() => publish(override), expected, JSON.stringify(override));
    }
    assert.equal(tasksTable().length, 0, 'nothing partial was written');
  });

  it('refuses a plaintext reference link', async () => {
    await assert.rejects(
      () => publish({ links: [{ kind: 'website', label: 'w', url: 'http://insecure.test' }] }),
      /https/
    );
  });
});

describe('entering', () => {
  beforeEach(seed);

  it('records an entry and numbers it', async () => {
    const { ref } = await publish();
    const first = await T.submitToTask(ALICE, ref, { url: 'https://x.com/alice/status/1234567890' }, c());
    const second = await T.submitToTask(BOB, ref, { url: 'https://x.com/bob/status/2222222222' }, c());

    assert.equal(first.submissionRef, 1);
    assert.equal(second.submissionRef, 2);
    assert.equal(subsTable().length, 2);
  });

  it('stores the canonical URL, not what was typed', async () => {
    const { ref } = await publish();
    await T.submitToTask(ALICE, ref, { url: 'https://twitter.com/Alice/status/1234567890?s=20' }, c());
    assert.equal(subsTable()[0].content_url, 'https://x.com/Alice/status/1234567890');
  });

  it('refuses the creator, so a task cannot be won by its author', async () => {
    const { ref } = await publish();
    await assert.rejects(
      () => T.submitToTask(CREATOR, ref, { url: 'https://x.com/creator/status/1111111111' }, c()),
      /your own/i
    );
    assert.equal(subsTable().length, 0);
  });

  it('refuses anything that is not one X post when the task asks for one', async () => {
    const { ref } = await publish();
    for (const url of ['https://example.com/hi', 'https://x.com/alice', 'not a url']) {
      await assert.rejects(() => T.submitToTask(ALICE, ref, { url }, c()), /x post/i, url);
    }
    assert.equal(subsTable().length, 0);
  });

  it('refuses an entry once the deadline has passed', async () => {
    const { ref } = await publish();
    closeTask(ref);
    await assert.rejects(
      () => T.submitToTask(ALICE, ref, { url: 'https://x.com/alice/status/1234567890' }, c()),
      /closed/i
    );
  });

  it('marks an entry verified only when the linked X handle matches', async () => {
    seed({
      channel_identities: [
        { id: 'i1', account_id: ALICE, channel: 'x', external_id: '9001', display_handle: 'AliceX' },
        { id: 'i2', account_id: BOB, channel: 'x', external_id: '9002', display_handle: 'SomeoneElse' },
      ],
    });
    const { ref } = await publish();

    const matched = await T.submitToTask(ALICE, ref, { url: 'https://x.com/alicex/status/1234567890' }, c());
    const mismatched = await T.submitToTask(BOB, ref, { url: 'https://x.com/notbob/status/2222222222' }, c());

    assert.equal(matched.verification, 'x_verified');
    assert.equal(mismatched.verification, 'unverified', 'a different handle is not proof');
  });

  it('turns nobody away for lacking an X account unless the task demands one', async () => {
    const { ref } = await publish();
    const got = await T.submitToTask(ALICE, ref, { url: 'https://x.com/alice/status/1234567890' }, c());
    assert.equal(got.verification, 'unverified');
    assert.equal(subsTable().length, 1, 'the entry still counts');
  });
});

describe('what the public may see', () => {
  beforeEach(seed);

  it('never returns entries while a task is live or under review', async () => {
    const { ref } = await publish();
    await T.submitToTask(ALICE, ref, { url: 'https://x.com/alice/status/1234567890' }, c());

    let detail = await T.getTaskByRef(ref, { viewerAccountId: null }, c());
    assert.equal(detail.state, 'live');
    assert.equal(detail.winners.length, 0);
    assert.ok(!('submissions' in detail));
    assert.equal(detail.participants, 1, 'the count is public, the entries are not');

    closeTask(ref);
    detail = await T.getTaskByRef(ref, { viewerAccountId: null }, c());
    assert.equal(detail.state, 'review');
    assert.equal(detail.winners.length, 0);
  });

  it('tells a viewer whether they already entered, without naming anyone else', async () => {
    const { ref } = await publish();
    await T.submitToTask(ALICE, ref, { url: 'https://x.com/alice/status/1234567890' }, c());

    const asAlice = await T.getTaskByRef(ref, { viewerAccountId: ALICE }, c());
    const asBob = await T.getTaskByRef(ref, { viewerAccountId: BOB }, c());
    assert.equal(asAlice.viewerHasEntered, true);
    assert.equal(asBob.viewerHasEntered, false);
  });

  it('never claims a reward is secured, because none is held', async () => {
    const { ref } = await publish();
    const detail = await T.getTaskByRef(ref, { viewerAccountId: null }, c());
    assert.equal(detail.rewardSecured, false);
  });
});

describe('reviewing and choosing winners', () => {
  beforeEach(seed);

  async function openWithTwoEntries() {
    const { ref } = await publish();
    await T.submitToTask(ALICE, ref, { url: 'https://x.com/alice/status/1234567890' }, c());
    await T.submitToTask(BOB, ref, { url: 'https://x.com/bob/status/2222222222' }, c());
    return ref;
  }

  it('withholds entries from the creator until the task closes', async () => {
    const ref = await openWithTwoEntries();
    await assert.rejects(() => T.listSubmissionsForCreator(CREATOR, ref, c()), /once the task closes/i);
  });

  it('answers a stranger the same way whether or not the task exists', async () => {
    const ref = await openWithTwoEntries();
    closeTask(ref);

    const real = await T.listSubmissionsForCreator(ALICE, ref, c()).catch((e) => e.message);
    const missing = await T.listSubmissionsForCreator(ALICE, 999999, c()).catch((e) => e.message);
    assert.equal(real, missing, 'a different answer would say which refs exist');
    assert.match(real, /not found/i);
  });

  it('publishes winners, completes the task and reports who to tell', async () => {
    const ref = await openWithTwoEntries();
    closeTask(ref);

    const { submissions } = await T.listSubmissionsForCreator(CREATOR, ref, c());
    const result = await T.finalizeWinners(CREATOR, ref, [
      { submissionId: submissions[0].id, place: 1, rewardNote: '$60' },
      { submissionId: submissions[1].id, place: 2, rewardNote: '$40' },
    ], c());

    assert.equal(result.notify.length, 2);
    assert.deepEqual(
      result.notify.map((n) => n.accountId),
      [ALICE, BOB]
    );
    assert.equal(tasksTable()[0].status, 'completed');
    assert.ok(tasksTable()[0].completed_at, 'a completed task carries its timestamp');
    assert.equal(winnersTable().length, 2);
  });

  it('refuses more winners than the task offered', async () => {
    const ref = await openWithTwoEntries();
    closeTask(ref);
    const { submissions } = await T.listSubmissionsForCreator(CREATOR, ref, c());

    // The task offers two, so ask for three by repeating one.
    await assert.rejects(
      () =>
        T.finalizeWinners(CREATOR, ref, [
          { submissionId: submissions[0].id, place: 1 },
          { submissionId: submissions[1].id, place: 2 },
          { submissionId: submissions[0].id, place: 3 },
        ], c()),
      /winner slots/i
    );
    assert.equal(winnersTable().length, 0, 'nothing partial was written');
    assert.equal(tasksTable()[0].status, 'live', 'and the task was not completed');
  });

  it('refuses two winners on one place', async () => {
    const ref = await openWithTwoEntries();
    closeTask(ref);
    const { submissions } = await T.listSubmissionsForCreator(CREATOR, ref, c());

    await assert.rejects(
      () =>
        T.finalizeWinners(CREATOR, ref, [
          { submissionId: submissions[0].id, place: 1 },
          { submissionId: submissions[1].id, place: 1 },
        ], c()),
      /share a place/i
    );
  });

  it('refuses an entry that belongs to another task', async () => {
    const ref = await openWithTwoEntries();
    const other = await publish({ title: 'A second task' });
    await T.submitToTask(ALICE, other.ref, { url: 'https://x.com/alice/status/3333333333' }, c());
    closeTask(ref);

    const strayId = subsTable().find((s) => s.content_url.includes('3333333333')).id;
    await assert.rejects(
      () => T.finalizeWinners(CREATOR, ref, [{ submissionId: strayId, place: 1 }], c()),
      /not in this task/i
    );
  });

  it('cannot be finalised twice', async () => {
    const ref = await openWithTwoEntries();
    closeTask(ref);
    const { submissions } = await T.listSubmissionsForCreator(CREATOR, ref, c());
    await T.finalizeWinners(CREATOR, ref, [{ submissionId: submissions[0].id, place: 1 }], c());

    await assert.rejects(
      () => T.finalizeWinners(CREATOR, ref, [{ submissionId: submissions[1].id, place: 1 }], c()),
      /already finished/i
    );
    assert.equal(winnersTable().length, 1);
  });

  it('shows the winning entries publicly once completed', async () => {
    const ref = await openWithTwoEntries();
    closeTask(ref);
    const { submissions } = await T.listSubmissionsForCreator(CREATOR, ref, c());
    await T.finalizeWinners(CREATOR, ref, [{ submissionId: submissions[0].id, place: 1 }], c());

    const detail = await T.getTaskByRef(ref, { viewerAccountId: null }, c());
    assert.equal(detail.state, 'completed');
    assert.equal(detail.winners.length, 1);
    assert.equal(detail.winners[0].username, 'alice');
    assert.match(detail.winners[0].url, /x\.com/);
  });
});

describe('withdrawing', () => {
  beforeEach(seed);

  it('only the creator may cancel, and only once', async () => {
    const { ref } = await publish();
    await assert.rejects(() => T.cancelTask(ALICE, ref, c()), /not found/i);

    await T.cancelTask(CREATOR, ref, c());
    assert.equal(tasksTable()[0].status, 'cancelled');
    assert.ok(tasksTable()[0].cancelled_at);

    await assert.rejects(() => T.cancelTask(CREATOR, ref, c()), /already finished/i);
  });

  it('a cancelled task takes no more entries', async () => {
    const { ref } = await publish();
    await T.cancelTask(CREATOR, ref, c());
    await assert.rejects(
      () => T.submitToTask(ALICE, ref, { url: 'https://x.com/alice/status/1234567890' }, c()),
      /closed/i
    );
  });

  it('keeps the entries people already made', async () => {
    const { ref } = await publish();
    await T.submitToTask(ALICE, ref, { url: 'https://x.com/alice/status/1234567890' }, c());
    await T.cancelTask(CREATOR, ref, c());
    assert.equal(subsTable().length, 1, 'somebody did that work; the record stays');
  });
});

describe('who may publish', () => {
  beforeEach(seed);

  it('is any account, not the admin flag', async () => {
    assert.equal(await T.canCreateTasks(CREATOR, c()), true);
    assert.equal(await T.canCreateTasks(ALICE, c()), true);
    assert.equal(await T.canCreateTasks('nobody', c()), false);
  });
});

describe('inputs are bounded', () => {
  beforeEach(seed);

  it('refuses oversized text rather than storing it', async () => {
    const big = 'x'.repeat(100000);
    const cases = [
      [{ description: big }, /description is too long/i],
      [{ rewardDisplay: big }, /reward line short/i],
      [{ requirements: [{ kind: 'text', label: big }] }, /requirement short/i],
      [
        { links: [{ kind: 'custom', label: big, url: 'https://ok.test' }] },
        /link label short/i,
      ],
      [
        { links: [{ kind: 'custom', label: 'l', url: `https://ok.test/${big}` }] },
        /link is too long/i,
      ],
    ];
    for (const [override, expected] of cases) {
      await assert.rejects(() => publish(override), expected, JSON.stringify(Object.keys(override)));
    }
    assert.equal(tasksTable().length, 0, 'nothing oversized was stored');
  });

  it('caps how many requirements and links one task may carry', async () => {
    const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
    await assert.rejects(
      () => publish({ requirements: many(11, () => ({ kind: 'text', label: 'x' })) }),
      /too many requirements/i
    );
    await assert.rejects(
      () =>
        publish({
          links: many(21, (i) => ({ kind: 'custom', label: 'l', url: `https://ok.test/${i}` })),
        }),
      /too many links/i
    );
  });

  it('normalises the distribution instead of storing whatever arrived', async () => {
    // It is shown to entrants as what each place pays, so it is checked. It used
    // to be stored as any JSON of any size, straight onto a public page.
    const { ref } = await publish({
      winnersCount: 2,
      distribution: [
        { place: 1, amount: '60' },
        { place: 2, amount: 'y'.repeat(500) },
        { place: 99, amount: 'not a place' },
        { junk: true },
      ],
    });

    const stored = tasksTable().find((t) => t.ref === ref).distribution;
    // Places 1 and 2 are real for a two-winner task and survive; place 99 and
    // the shapeless entry do not.
    assert.equal(stored.length, 2, 'only entries naming a real place survive');
    assert.deepEqual(stored[0], { place: 1, amount: '60' });
    assert.equal(stored[1].place, 2);
    assert.equal(stored[1].amount.length, 40, 'and an oversized amount is trimmed');
  });

  it('keeps a distribution entry trimmed rather than dropped', async () => {
    const { ref } = await publish({
      winnersCount: 2,
      distribution: [{ place: 2, amount: 'z'.repeat(200) }],
    });
    const stored = tasksTable().find((t) => t.ref === ref).distribution;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].amount.length, 40, 'trimmed to the cap, not discarded');
  });
});

describe('project profiles', () => {
  beforeEach(seed);

  it('keeps the owner off the public page and lists that project\'s tasks', async () => {
    const project = await T.createProject(
      CREATOR,
      {
        name: 'Flizy',
        handle: 'flizy',
        description: 'Social crypto wallet built around messaging.',
        links: [
          { kind: 'website', label: 'Website', url: 'https://flizy.app' },
          { kind: 'x', label: '', url: 'https://x.com/Flizyapp' },
        ],
      },
      c()
    );
    await assert.rejects(
      () =>
        T.createProject(
          ALICE,
          {
            name: 'Other',
            handle: 'otherproj',
            links: [{ kind: 'telegram', label: 'Telegram', url: 'http://t.me/flizy' }],
          },
          c()
        ),
      /https/i
    );
    assert.equal(project.handle, 'flizy');
    await T.createTask(
      CREATOR,
      {
        title: 'Create an X post about Flizy',
        description: 'Explain what Flizy does.',
        rewardKind: 'custom',
        rewardDisplay: '10 WL spots',
        winnersCount: 1,
        endsAt: future(),
        projectId: project.id,
        requirements: [{ kind: 'x_post', label: 'Submit the post URL' }],
      },
      c()
    );
    fake.db.tables.tasks[0].created_at = new Date().toISOString();

    const page = await T.getPublicProject('flizy', c());
    assert.equal(page.name, 'Flizy');
    assert.equal(page.description, 'Social crypto wallet built around messaging.');
    assert.equal(page.links.length, 2);
    assert.equal(page.links[1].label, 'X');
    assert.equal(page.tasks.length, 1);
    assert.equal(page.tasks[0].creator.kind, 'project');
    assert.equal(page.activity.length, 1);
    const dumped = JSON.stringify(page);
    assert.equal(dumped.includes(CREATOR), false);
    assert.equal(dumped.includes('owner_account_id'), false);
  });

  it('refuses a handle that is already a username', async () => {
    await assert.rejects(
      () => T.createProject(CREATOR, { name: 'Alice', handle: 'alice' }, c()),
      /unavailable|taken|not available/i
    );
  });
});
