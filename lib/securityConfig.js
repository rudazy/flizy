/**
 * Boot check of the switches that keep chat money safe.
 *
 * Each of these is one line in the bot's .env, and each turns a protection off
 * without any other sign: REQUIRE_UNLOCK=false skips the PIN unlock before
 * chat moves money, ENFORCE_TRUSTED=false skips the trusted list. REQUIRE_UNLOCK
 * sat at false on the production host with nothing noticing, because nothing
 * was looking. A missing SECURITY_MAIL_SECRET is the same kind of silence: the
 * owner is no longer emailed when a chat is linked or unlinked.
 *
 * The bot still starts. Stopping it would not turn the protection back on, it
 * would only add an outage. In production the finding goes to Sentry under
 * alert=schema_exposure, the tag the existing alert rule listens on.
 */

const { config } = require('./config');

/**
 * @param {{ requireUnlock: boolean, enforceTrusted: boolean }} [cfg]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} one line per switch that is off
 */
function unsafeSecuritySettings(cfg = config, env = process.env) {
  const problems = [];
  if (!cfg.requireUnlock) {
    problems.push('REQUIRE_UNLOCK is off: chat moves money without a PIN unlock.');
  }
  if (!cfg.enforceTrusted) {
    problems.push('ENFORCE_TRUSTED is off: chat sends to addresses skip the trusted list.');
  }
  if (!String(env.SECURITY_MAIL_SECRET || '').trim()) {
    problems.push('SECURITY_MAIL_SECRET is not set: owners are not emailed when a chat is linked or unlinked.');
  }
  return problems;
}

/** Settings that no longer do anything. Admin is accounts.is_admin only. */
const RETIRED = ['ADMIN_PHONES', 'ADMIN_SETUP_SECRET'];

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} one line per retired setting still present
 */
function retiredSettings(env = process.env) {
  return RETIRED.filter((name) => String(env[name] || '').trim()).map(
    (name) => `${name} is set but retired: it grants nothing now. Remove it from the bot .env.`
  );
}

/**
 * Log what is off, and report it when running in production. A retired
 * setting is only logged: it can no longer grant anything, so it is clutter
 * to clean up, not an alert.
 *
 * @param {{ service: string, warn: Function, report: Function, cfg?: object, env?: NodeJS.ProcessEnv }} deps
 * @returns {boolean} whether anything was off
 */
function checkSecuritySettings({ service, warn, report, cfg = config, env = process.env }) {
  for (const line of retiredSettings(env)) warn(`[config] ${line}`);
  const problems = unsafeSecuritySettings(cfg, env);
  if (!problems.length) return false;
  const message = [
    `SECURITY CONFIG: ${service} started with protections off.`,
    ...problems.map((p) => `  - ${p}`),
    'Fix the bot .env and restart.',
  ].join('\n');
  warn(`\n${message}\n`);
  if (env.NODE_ENV === 'production') report(message);
  return true;
}

module.exports = { unsafeSecuritySettings, retiredSettings, checkSecuritySettings };
