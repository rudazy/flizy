/**
 * Home's "Your tasks" counts: the tasks an account has entered, by where each
 * task stands now, and nothing about any other account.
 *
 * Run: node --test test/enteredTaskCounts.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

let T;

before(async () => {
  T = await import('../web/lib/tasks.ts');
  // No test here may reach a real database; see test/taskLifecycle.test.js.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const future = () => new Date(Date.now() + 3600e3).toISOString();
const past = () => new Date(Date.now() - 3600e3).toISOString();

function fakeWith(tasks, submissions) {
  return createFakeSupabase({ tasks, task_submissions: submissions }).client;
}

describe('countEnteredTasks', () => {
  it('buckets entered tasks by derived state', async () => {
    const client = fakeWith(
      [
        { id: 't1', status: 'live', ends_at: future() },
        { id: 't2', status: 'live', ends_at: past() },
        { id: 't3', status: 'completed', ends_at: past() },
        { id: 't4', status: 'cancelled', ends_at: future() },
        { id: 't5', status: 'live', ends_at: future() },
      ],
      [
        { id: 's1', task_id: 't1', account_id: 'me' },
        { id: 's2', task_id: 't2', account_id: 'me' },
        { id: 's3', task_id: 't3', account_id: 'me' },
        { id: 's4', task_id: 't4', account_id: 'me' },
        { id: 's5', task_id: 't5', account_id: 'someone-else' },
      ]
    );
    assert.deepEqual(await T.countEnteredTasks('me', client), { live: 1, review: 1, completed: 1, cancelled: 1 });
  });

  it('is all zeros for an account that entered nothing, and for no account', async () => {
    const client = fakeWith([{ id: 't1', status: 'live', ends_at: future() }], []);
    const zero = { live: 0, review: 0, completed: 0, cancelled: 0 };
    assert.deepEqual(await T.countEnteredTasks('me', client), zero);
    assert.deepEqual(await T.countEnteredTasks('', client), zero);
  });
});

describe('GET /api/tasks/mine', () => {
  it('takes the account from the session, never from the request', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'web', 'app', 'api', 'tasks', 'mine', 'route.ts'),
      'utf8'
    );
    assert.match(src, /export async function GET\(\)/);
    assert.match(src, /const accountId = await getAccountIdFromCookie\(\);/);
    assert.match(src, /countEnteredTasks\(accountId\)/);
  });
});
