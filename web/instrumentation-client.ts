/**
 * Error reporting in the browser.
 *
 * The server half (instrumentation-node.ts) and the bots (lib/sentry.js) have
 * had this since August. The browser had nothing, so a React render error, a
 * failed fetch in a dashboard panel or a thrown exception in the pay flow was
 * only ever visible to the person it happened to.
 *
 * `instrumentation-client.ts` rather than `sentry.client.config.ts`: the SDK
 * accepts both and prints a deprecation warning for the latter, and only this
 * one survives Turbopack. Sentry injects it into the client entry itself, from
 * withSentryConfig in next.config.mjs, so Next 14 not knowing the convention
 * natively does not matter. Without that wrapper this file is never bundled.
 *
 * Same three rules as the other two halves:
 *
 * 1. **It does not run without a DSN, and not outside production.** Absence of
 *    the variable is the off switch, so a local session or a preview deploy
 *    cannot post to a third party by anyone forgetting something.
 *
 * 2. **It sends no breadcrumbs.** In a browser those are navigation, console
 *    output and fetch URLs, which on this site means `/claim/<token>` and the
 *    contents of a dashboard request. `beforeBreadcrumb` returning null is the
 *    browser equivalent of the bot's `defaultIntegrations: false`, which cannot
 *    be used here because the same defaults include the handler that catches
 *    the error in the first place.
 *
 * 3. **It sends nothing the scrubber has not seen.** `beforeSend` runs
 *    web/lib/errorScrub.ts, which deletes `request` (and with it the page URL),
 *    `user` and `server_name`, and redacts emails, wallet addresses, phone
 *    numbers, account ids and claim tokens out of free text.
 *
 * No tracing and no session replay, both deliberately. Replay is a recording of
 * the page, which is the thing that was just taken off the dashboard for
 * Clarity; adding it back under a different vendor would be the same mistake.
 */

import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from './lib/errorScrub';

const DSN = (process.env.NEXT_PUBLIC_SENTRY_DSN || '').trim();

/**
 * What to call this deployment.
 *
 * A Vercel preview builds with NODE_ENV=production and inherits the production
 * environment variables, which is the trap components/Analytics.tsx already
 * documents. Without this, every preview error would arrive tagged `production`
 * and quietly make the production error stream a lie. Preview errors are worth
 * having, so they are labelled rather than suppressed.
 *
 * An explicit override wins, because naming the environment is an operator
 * decision and this is only a better default.
 */
function sentryEnvironment(): string {
  const explicit = (process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || '').trim();
  if (explicit) return explicit;
  return (process.env.NEXT_PUBLIC_VERCEL_ENV || '').trim() || 'production';
}

if (DSN && process.env.NODE_ENV === 'production') {
  Sentry.init({
    dsn: DSN,
    environment: sentryEnvironment(),
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // Explicit zeroes rather than trusting a default: replay is off, and it
    // should take a deliberate edit to this line to turn it on.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend: (event) => scrubEvent(event) as never,
    beforeBreadcrumb: () => null,
    initialScope: { tags: { service: 'flizy-web-client' } },
  });
}

/**
 * Sentry's setup guide also has this file export `onRouterTransitionStart`.
 * Deliberately absent. That hook exists to instrument navigation for tracing,
 * Next only calls it from 15.3 and this project is on 14.2, and tracing is off
 * anyway, so it would be a dead export with a comment claiming it was required.
 * It belongs here the day tracing is turned on, not before.
 */
export {};
