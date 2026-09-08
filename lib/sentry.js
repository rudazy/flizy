/**
 * Error reporting for the bot processes, off by default.
 *
 * Three things this deliberately does NOT do, each because the alternative is
 * worse in a money app:
 *
 * 1. **It does not run without a DSN, and not outside production.** A test run
 *    or a local session must never post an error to a third party. Absence of
 *    the variable is the off switch, so nothing has to be remembered.
 *
 * 2. **It does not use the SDK's default integrations.** `@sentry/node` ships
 *    OpenTelemetry auto-instrumentation that patches http and database clients
 *    and attaches request and query data to events. That is precisely the data
 *    that must not leave: phone numbers in a URL, an account id in a query.
 *    Everything is opt-in here instead.
 *
 * 3. **It does not send anything the scrubber has not seen.** `beforeSend` runs
 *    lib/errorScrub.js over the whole event. If scrubbing throws, a placeholder
 *    goes instead of the event -- never the raw one, and never nothing.
 *
 * What it is for: the bots had no `uncaughtException` or `unhandledRejection`
 * handler at all, so a rejected promise took the process down with a bare stack
 * on stdout that nobody was reading.
 */

// Loaded here, not left to the caller. dotenv only runs when lib/runtime is
// required, which in index.js happens well after this module -- so reading
// SENTRY_DSN without this returned undefined and reporting silently never
// started on the WhatsApp bot. config() does not overwrite variables that are
// already set, so calling it twice is free and the ordering trap is gone for
// whoever wires the next entrypoint.
require('dotenv').config();

const { scrubEvent } = require('./errorScrub');

let started = false;

/** True only when reporting is configured and we are actually in production. */
function sentryEnabled() {
  return Boolean(process.env.SENTRY_DSN) && process.env.NODE_ENV === 'production';
}

/**
 * Start error reporting, once, if it is configured.
 *
 * @param {string} serviceName which bot this is, so events can be told apart
 * @returns {boolean} whether reporting is now on
 */
function initSentry(serviceName) {
  if (started) return true;
  if (!sentryEnabled()) return false;

  let Sentry;
  try {
    // Required lazily so a machine without the package, or without a DSN, does
    // not fail to boot the bot over its error reporter.
    // eslint-disable-next-line global-require
    Sentry = require('@sentry/node');
  } catch {
    console.warn('[sentry] package not installed; error reporting is off');
    return false;
  }

  try {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT || 'production',
      release: process.env.SENTRY_RELEASE || undefined,
      // Never the SDK's idea of "default PII", and never its auto-instrumentation.
      sendDefaultPii: false,
      defaultIntegrations: false,
      integrations: [],
      // Errors only. Tracing would sample real requests, which is more data
      // leaving for less benefit than a money app should accept by default.
      tracesSampleRate: 0,
      beforeSend: (event) => scrubEvent(event),
      beforeBreadcrumb: () => null,
      initialScope: { tags: { service: serviceName || 'flizy' } },
    });
    started = true;
    console.log(`[sentry] error reporting on for ${serviceName}`);
    return true;
  } catch (err) {
    console.warn('[sentry] could not start:', err && err.message);
    return false;
  }
}

/**
 * Report an error that was already handled, without changing what the caller
 * does about it. Safe to call when reporting is off.
 */
function reportError(err, context = {}) {
  if (!started) return;
  try {
    // eslint-disable-next-line global-require
    const Sentry = require('@sentry/node');
    Sentry.captureException(err, { extra: scrubEvent(context) });
  } catch {
    // Reporting must never become the reason something fails.
  }
}

/**
 * Catch what would otherwise end the process silently.
 *
 * The handlers are installed whether or not Sentry is on, because the logging
 * half is useful on its own and the bots had neither before this.
 */
function installProcessHandlers(serviceName) {
  process.on('unhandledRejection', (reason) => {
    console.error(`[${serviceName}] unhandled rejection:`, reason);
    reportError(reason instanceof Error ? reason : new Error(String(reason)), {
      kind: 'unhandledRejection',
    });
  });

  process.on('uncaughtException', (err) => {
    console.error(`[${serviceName}] uncaught exception:`, err);
    reportError(err, { kind: 'uncaughtException' });
    // Deliberately not exiting. A bot that stays up with one broken message is
    // better than one that stops answering everybody, and the supervisor has no
    // way to tell a fatal state from a single bad update.
  });
}

// Two functions above are deliberately not exported. `sentryEnabled` is an
// internal predicate, and `reportError` has no caller outside the process
// handlers yet -- exporting either now would be a surface nothing uses.
// Exporting them is one line when something needs them.
module.exports = {
  initSentry,
  installProcessHandlers,
};
