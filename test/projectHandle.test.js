/**
 * Project handle availability, and the active-task count on the account list.
 *
 * The username picker treats a person's own name as free. A project handle
 * must not. These tests pin that, plus the shared sentence for reserved and
 * taken names, and that "active" means a task that is still open.
 *
 * Run: node --test test/projectHandle.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

let T;
let USERNAME_UNAVAILABLE;
let BRAND_NAME;
let fake;

before(async () => {
  T = await import('../web/lib/tasks.ts');
  ({ USERNAME_UNAVAILABLE } = await import('../web/lib/username.ts'));
  BRAND_NAME = 'Names and titles cannot use the Flizy name.';
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
    reserved_usernames: [{ normalized_name: 'admin' }],
    ...extra,
  });
}

const c = () => fake.client;
const future = () => new Date(Date.now() + 3600e3).toISOString();
const past = () => new Date(Date.now() - 3600e3).toISOString();

describe('project handle availability', () => {
  beforeEach(seed);

  it('refuses the signed-in account username, and any other username, with one sentence', async () => {
    const own = await T.projectHandleAvailable('alice', ALICE, c());
    const other = await T.projectHandleAvailable('@Bob', ALICE, c());
    assert.equal(own.available, false);
    assert.equal(other.available, false);
    assert.equal(own.reason, USERNAME_UNAVAILABLE);
    assert.equal(other.reason, USERNAME_UNAVAILABLE);
  });

  it('refuses a reserved name and a handle a project already has, with the same sentence', async () => {
    fake.db.tables.projects.push({
      id: 'p-taken',
      owner_account_id: BOB,
      handle: 'teamone',
      name: 'Team One',
      description: '',
    });
    const reserved = await T.projectHandleAvailable('admin', ALICE, c());
    const taken = await T.projectHandleAvailable('teamone', ALICE, c());
    assert.equal(reserved.available, false);
    assert.equal(taken.available, false);
    assert.equal(reserved.reason, USERNAME_UNAVAILABLE);
    assert.equal(taken.reason, USERNAME_UNAVAILABLE);
  });

  it('allows a free handle, and refuses a short one as a format error', async () => {
    const free = await T.projectHandleAvailable('Renault', ALICE, c());
    assert.deepEqual(free, { available: true, handle: 'renault' });
    const short = await T.projectHandleAvailable('ab', ALICE, c());
    assert.equal(short.available, false);
    assert.match(short.reason, /at least 3/);
  });

  it('refuses a handle that uses the Flizy name unless the account is an admin', async () => {
    const person = await T.projectHandleAvailable('flizyhq', ALICE, c());
    assert.equal(person.available, false);
    assert.equal(person.reason, BRAND_NAME);
    const admin = await T.projectHandleAvailable('flizyhq', ADMIN, c());
    assert.deepEqual(admin, { available: true, handle: 'flizyhq' });
  });

  it('lets an admin check and create a reserved brand handle, and nobody else', async () => {
    fake.db.tables.reserved_usernames.push({ normalized_name: 'flizy' });
    const person = await T.projectHandleAvailable('flizy', ALICE, c());
    assert.equal(person.available, false);
    assert.equal(person.reason, USERNAME_UNAVAILABLE);
    await assert.rejects(
      () => T.createProject(ALICE, { name: 'Team One', handle: 'flizy' }, c()),
      { message: USERNAME_UNAVAILABLE }
    );

    const admin = await T.projectHandleAvailable('flizy', ADMIN, c());
    assert.deepEqual(admin, { available: true, handle: 'flizy' });
    const made = await T.createProject(ADMIN, { name: 'Flizy', handle: 'flizy' }, c());
    assert.equal(made.handle, 'flizy');
  });

  it('keeps a reserved name that is not the brand refused for an admin too', async () => {
    const admin = await T.projectHandleAvailable('admin', ADMIN, c());
    assert.equal(admin.available, false);
    assert.equal(admin.reason, USERNAME_UNAVAILABLE);
  });

  it('tells a taken brand handle about the brand name, which is what create would say', async () => {
    fake.db.tables.projects.push({
      id: 'p-brand',
      owner_account_id: ADMIN,
      handle: 'flizyhq',
      name: 'Flizy',
      description: '',
    });
    const person = await T.projectHandleAvailable('flizyhq', ALICE, c());
    assert.equal(person.reason, BRAND_NAME);
  });
});

describe('active tasks on the owned list', () => {
  beforeEach(seed);

  it('counts only tasks that are still open, on this account', async () => {
    fake.db.tables.projects.push(
      {
        id: 'p1',
        owner_account_id: ALICE,
        handle: 'renault',
        name: 'Renault',
        description: 'Cars',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'p2',
        owner_account_id: BOB,
        handle: 'bobsproj',
        name: 'Bobs',
        description: null,
        created_at: '2026-01-02T00:00:00.000Z',
      }
    );
    fake.db.tables.tasks.push(
      { id: 't-open', project_id: 'p1', status: 'live', ends_at: future() },
      { id: 't-closed', project_id: 'p1', status: 'live', ends_at: past() },
      { id: 't-done', project_id: 'p1', status: 'completed', ends_at: future() },
      { id: 't-cancelled', project_id: 'p1', status: 'cancelled', ends_at: future() },
      { id: 't-other', project_id: 'p2', status: 'live', ends_at: future() }
    );

    const rows = await T.listOwnProjects(ALICE, c());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].handle, 'renault');
    assert.equal(rows[0].activeTasks, 1);
    assert.equal(rows[0].description, 'Cars');
    assert.equal(Object.hasOwn(rows[0], 'owner_account_id'), false);
  });

  it('keeps the projects when the task count fails', async () => {
    fake.db.tables.projects.push({
      id: 'p1',
      owner_account_id: ALICE,
      handle: 'renault',
      name: 'Renault',
      description: '',
    });
    const base = fake.client;
    const client = {
      rpc: base.rpc.bind(base),
      from(table) {
        const query = base.from(table);
        if (table !== 'tasks') return query;
        const select = query.select.bind(query);
        query.select = (cols, opts) => {
          const next = select(cols, opts);
          if (opts && opts.head) {
            next.then = (resolve) => {
              resolve({ data: null, error: { message: 'count refused' }, count: null });
            };
          }
          return next;
        };
        return query;
      },
    };

    const rows = await T.listOwnProjects(ALICE, client);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].activeTasks, 0);
    assert.equal(rows[0].name, 'Renault');
  });
});
