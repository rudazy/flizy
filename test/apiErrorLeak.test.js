/**
 * API routes must not hand a raw error message to a client.
 *
 * Supabase error text carries table names, column names, constraint names and
 * sometimes the failing value, so `{ error: error.message }` on any route
 * returned a piece of the schema to whoever asked. Thrown ethers and fetch
 * errors leak RPC hosts and internal paths the same way.
 *
 * The route handlers themselves cannot be imported here: they read a Next
 * request cookie, and web/lib/supabase.ts builds a real client from the .env in
 * the repo root, so importing one would point a unit test at the production
 * database. Same reasoning as test/pinRouteGate.test.js. So this file tests the
 * helper every route now goes through, and then scans the route files to prove
 * none of them bypasses it.
 *
 * Run: node --test test/apiErrorLeak.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_DIR = path.join(__dirname, '..', 'web', 'app', 'api');

let apiError;
before(async () => {
  apiError = await import('../web/lib/apiError.ts');
});

/** Capture console.error for one call. */
async function capturing(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

/** A Supabase failure, shaped the way PostgREST actually returns one. */
function databaseFailure() {
  return {
    message:
      'column accounts.unlock_pin_hash does not exist (relation "public.accounts", constraint accounts_email_key)',
    code: '42703',
    details: 'Perhaps you meant to reference the column "accounts.password_hash".',
  };
}

describe('a simulated database failure tells the client nothing', () => {
  it('returns the generic message, not the underlying text', async () => {
    const err = databaseFailure();
    const { result } = await capturing(() => apiError.apiErrorBody('POST /api/pin', err));

    assert.equal(result.error, apiError.CLIENT_ERROR_MESSAGE);
    assert.ok(!result.error.includes('accounts'));
    assert.ok(!result.error.includes('unlock_pin_hash'));
    assert.ok(!result.error.includes('42703'));
    assert.ok(!result.error.includes('does not exist'));
  });

  it('still logs the real thing server-side, with the route', async () => {
    const err = databaseFailure();
    const { lines } = await capturing(() =>
      apiError.apiErrorBody('POST /api/pin', err, { accountId: 'acc-1' })
    );

    assert.equal(lines.length, 1);
    assert.match(lines[0], /POST \/api\/pin/);
    assert.match(lines[0], /unlock_pin_hash/);
    assert.match(lines[0], /code=42703/);
    assert.match(lines[0], /accountId=acc-1/);
  });

  it('cannot answer generically without leaving a trace', async () => {
    const { lines } = await capturing(() => apiError.apiErrorBody('GET /api/history', 'boom'));
    assert.equal(lines.length, 1);
  });

  it('handles a thrown Error and a non-Error alike', async () => {
    const { result: a } = await capturing(() =>
      apiError.apiErrorBody('GET /api/holdings', new Error('connect ECONNREFUSED 10.0.0.5:5432'))
    );
    const { result: b } = await capturing(() => apiError.apiErrorBody('GET /api/holdings', null));
    assert.equal(a.error, apiError.CLIENT_ERROR_MESSAGE);
    assert.equal(b.error, apiError.CLIENT_ERROR_MESSAGE);
  });

  it('keeps a secret out of the log line as well', async () => {
    const key = `0x${'ab'.repeat(32)}`;
    const { lines } = await capturing(() =>
      apiError.apiErrorBody('POST /api/swap/execute', new Error(`bad signer key ${key}`))
    );
    assert.ok(!lines[0].includes(key));
    assert.match(lines[0], /\[redacted\]/);
  });

  it('drops empty context rather than logging accountId=', async () => {
    const { lines } = await capturing(() =>
      apiError.apiErrorBody('GET /api/dashboard', new Error('x'), { accountId: null })
    );
    assert.ok(!lines[0].includes('accountId'));
  });
});

describe('messages the code deliberately wrote still get through', () => {
  it('passes a ClientError message to the client unchanged', async () => {
    const { result, lines } = await capturing(() =>
      apiError.apiErrorBodyAllowingClientError(
        'POST /api/trusted',
        new apiError.ClientError('Invalid address')
      )
    );
    assert.equal(result.error, 'Invalid address');
    // Nothing unexpected happened, so nothing to log
    assert.equal(lines.length, 0);
  });

  it('generalises anything else in that same catch', async () => {
    const { result } = await capturing(() =>
      apiError.apiErrorBodyAllowingClientError('POST /api/trusted', databaseFailure())
    );
    assert.equal(result.error, apiError.CLIENT_ERROR_MESSAGE);
  });

  it('treats a plain Error as unsafe even with friendly wording', async () => {
    const { result } = await capturing(() =>
      apiError.apiErrorBodyAllowingClientError('POST /api/trusted', new Error('Invalid address'))
    );
    assert.equal(result.error, apiError.CLIENT_ERROR_MESSAGE);
  });
});

/** Every route.ts under web/app/api. */
function routeFiles(dir = API_DIR, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, found);
    else if (entry.name === 'route.ts') found.push(full);
  }
  return found;
}

describe('no route sends a raw error message', () => {
  it('finds the routes to check', () => {
    assert.ok(routeFiles().length >= 12, `found ${routeFiles().length}`);
  });

  it('has no route returning err.message or error.message to the client', () => {
    // The two shapes this batch removed. Inspecting a message server-side is
    // fine; putting it in a response body is what this forbids.
    const offenders = [];
    for (const file of routeFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      const rel = path.relative(API_DIR, file).replace(/\\/g, '/');
      for (const [i, line] of source.split('\n').entries()) {
        if (/error:\s*(err|error|wErr|swapErr)\w*\.message/.test(line)) {
          offenders.push(`${rel}:${i + 1} ${line.trim()}`);
        }
        if (/err\s+instanceof\s+Error\s*\?\s*err\.message/.test(line)) {
          offenders.push(`${rel}:${i + 1} ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('routes that can fail go through the shared helper', () => {
    const missing = [];
    for (const file of routeFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      const rel = path.relative(API_DIR, file).replace(/\\/g, '/');
      // A route with no catch block has nothing to leak (withdraw is a stub)
      if (!/catch\s*\(/.test(source)) continue;
      if (!/apiErrorBody/.test(source)) missing.push(rel);
    }
    assert.deepEqual(missing, []);
  });
});

describe("Next's dynamic-usage signal is control flow, not an error", () => {
  it('rethrows it instead of logging a fake 500', async () => {
    // Thrown through route handlers during the build when a route reads cookies.
    // Swallowing it filled the build output with errors that were not errors.
    const dynamic = Object.assign(new Error('Dynamic server usage: cookies'), {
      digest: 'DYNAMIC_SERVER_USAGE',
    });
    const { lines } = await capturing(async () => {
      assert.throws(() => apiError.apiErrorBody('GET /api/dashboard', dynamic), /Dynamic server usage/);
    });
    assert.equal(lines.length, 0);
  });

  it('recognises it by name as well as digest', async () => {
    const byName = new Error('no cookies in static render');
    byName.name = 'DynamicServerError';
    await capturing(async () => {
      assert.throws(() => apiError.apiErrorBody('GET /api/history', byName));
    });
  });

  it('still handles an ordinary error normally', async () => {
    const { result } = await capturing(() =>
      apiError.apiErrorBody('GET /api/dashboard', new Error('real failure'))
    );
    assert.equal(result.error, apiError.CLIENT_ERROR_MESSAGE);
  });
});
