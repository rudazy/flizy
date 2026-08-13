/**
 * Resolve, and guard, the DEV database connection target.
 *
 * Both dev tools (run-dev-migrations.js, verify-dev-schema.js) connected with
 * their own copy of this guard. Two copies of the code that decides which
 * database is safe to write to is the one duplication this repo should never
 * carry, so it lives here once and both call it.
 *
 * THE GUARD IS UNCHANGED. The target must be declared dev in two independent,
 * agreeing places before any connection is built:
 *   - SUPABASE_URL      the project the ref is derived from
 *   - DEV_SUPABASE_REF  an explicit statement of which ref is the dev one
 * Only .env.dev is read. process.env is never consulted, so an ambient
 * SUPABASE_URL or a production .env on disk cannot steer this.
 *
 * DIRECT VS POOLER. By default this connects to db.<ref>.supabase.co, which on
 * some networks resolves IPv6-only and times out. Setting
 * SUPABASE_DB_POOLER_HOST switches to Supabase's connection pooler, which is
 * IPv4 reachable.
 *
 * The pooler does not widen what can be reached. Supabase routes a pooler
 * connection by the tenant encoded in the username, and that username is built
 * here as postgres.<ref> using the ref that already passed the two-place check.
 * A pooler host cannot therefore be pointed at a different project than the one
 * declared dev: changing the host changes the region, never the tenant. The
 * host is additionally required to be a *.pooler.supabase.com name so it cannot
 * be aimed at an arbitrary machine.
 */

const fs = require('fs');
const dotenv = require('dotenv');

/** Values still carrying template text, treated as "not filled in". */
const PLACEHOLDER = /^(your_|0xyour_|fresh_dev_only_|change-this)|^$/i;

/** Supabase pooler hostnames only. Keeps the host from being aimed anywhere. */
const POOLER_HOST = /^[a-z0-9-]+\.pooler\.supabase\.com$/i;

/** Session mode. Transaction mode (6543) is not safe for multi-statement DDL. */
const DEFAULT_POOLER_PORT = 5432;

/**
 * Validate a parsed .env.dev and build a connection descriptor.
 *
 * Pure: takes an already-parsed object, touches no filesystem and no network,
 * so the guard itself is unit testable. Throws on any violation.
 *
 * @param {Record<string, string>} env parsed .env.dev
 */
function resolveDevTarget(env) {
  const url = (env.SUPABASE_URL || '').trim();
  const declaredRef = (env.DEV_SUPABASE_REF || '').trim();
  const password = env.SUPABASE_DB_PASSWORD || '';

  for (const [name, value] of [
    ['DEV_SUPABASE_REF', declaredRef],
    ['SUPABASE_URL', url],
    ['SUPABASE_DB_PASSWORD', password],
  ]) {
    if (PLACEHOLDER.test(value)) {
      throw new Error(`${name} is empty or still a placeholder in .env.dev.`);
    }
  }

  const match = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co\/?$/i);
  if (!match) {
    throw new Error(`SUPABASE_URL is not a Supabase project URL: ${url}`);
  }
  const ref = match[1];

  if (ref !== declaredRef) {
    throw new Error(
      'dev guard tripped: SUPABASE_URL and DEV_SUPABASE_REF disagree.\n' +
        `  SUPABASE_URL points at project: ${ref}\n` +
        `  DEV_SUPABASE_REF declares:      ${declaredRef}\n` +
        'Refusing to connect. If the URL is correct, this is the check telling\n' +
        'you the project you are about to migrate is not the one you called dev.'
    );
  }

  const blocked = (env.BLOCKED_SUPABASE_REFS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (blocked.includes(ref)) {
    throw new Error(`project ref ${ref} is in BLOCKED_SUPABASE_REFS. Refusing.`);
  }

  const poolerHost = (env.SUPABASE_DB_POOLER_HOST || '').trim();
  const usePooler = !PLACEHOLDER.test(poolerHost);

  let target;
  if (usePooler) {
    if (!POOLER_HOST.test(poolerHost)) {
      throw new Error(
        `SUPABASE_DB_POOLER_HOST is not a Supabase pooler hostname: ${poolerHost}\n` +
          '  Expected something like aws-0-eu-west-1.pooler.supabase.com'
      );
    }

    const rawPort = (env.SUPABASE_DB_POOLER_PORT || '').trim();
    let port = DEFAULT_POOLER_PORT;
    if (rawPort) {
      port = Number(rawPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`SUPABASE_DB_POOLER_PORT is not a valid port: ${rawPort}`);
      }
    }

    target = {
      mode: 'pooler',
      host: poolerHost,
      port,
      // Carries the guarded ref. This is what pins the tenant, not the host.
      user: `postgres.${ref}`,
    };
  } else {
    target = {
      mode: 'direct',
      host: `db.${ref}.supabase.co`,
      port: 5432,
      user: 'postgres',
    };
  }

  return {
    ref,
    ...target,
    database: 'postgres',
    clientConfig: {
      host: target.host,
      port: target.port,
      user: target.user,
      password,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
    },
  };
}

/**
 * Human readable lines describing the target. Never includes the password.
 * Printed before anything is executed, including on a dry run.
 *
 * @param {ReturnType<typeof resolveDevTarget>} target
 */
function describeTarget(target) {
  const route =
    target.mode === 'pooler'
      ? 'pooler   (SUPABASE_DB_POOLER_HOST set; IPv4)'
      : 'direct   (no SUPABASE_DB_POOLER_HOST set)';

  return [
    `  route       : ${route}`,
    `  target host : ${target.host}`,
    `  port        : ${target.port}`,
    `  user        : ${target.user}`,
    `  project ref : ${target.ref}  (matches DEV_SUPABASE_REF)`,
    `  database    : ${target.database}`,
  ];
}

/**
 * Read .env.dev and resolve the target. Throws with an operator message.
 * @param {string} envFile absolute path to .env.dev
 */
function loadDevTarget(envFile) {
  if (!fs.existsSync(envFile)) {
    throw new Error(
      `.env.dev not found at ${envFile}\n` +
        'Copy .env.dev.example to .env.dev and fill in the dev Supabase values.'
    );
  }
  // Parsed, not injected into process.env, so nothing here can leak into other
  // libraries that read process.env later in the same process.
  return resolveDevTarget(dotenv.parse(fs.readFileSync(envFile)));
}

module.exports = {
  PLACEHOLDER,
  POOLER_HOST,
  DEFAULT_POOLER_PORT,
  resolveDevTarget,
  describeTarget,
  loadDevTarget,
};
