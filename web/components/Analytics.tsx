import { cookies } from 'next/headers';
import { analyticsAllowed, CONSENT_COOKIE } from '../lib/consent';
import { AnalyticsScripts } from './AnalyticsScripts';

/**
 * Optional GA4 + Microsoft Clarity + Umami Cloud.
 *
 * Three gates, and a tag has to pass all of them:
 *  1. Production only, never preview or development (isMeasurableEnv).
 *  2. A real id for that service, checked by shape.
 *  3. The visitor accepted, read from the cookie on the server so a refused
 *     tag is never in the document rather than shipped and suppressed.
 *
 * The fourth gate is WHERE, and it lives in AnalyticsScripts because only the
 * client knows the path after a soft navigation. See lib/analyticsRoutes.ts.
 */

const GA_ID = (process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || '').trim();
const CLARITY_ID = (process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID || '').trim();
const UMAMI_ID = (process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID || '').trim();
const UMAMI_SRC = (
  process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL || 'https://cloud.umami.is/script.js'
).trim();

/**
 * Preview deploys inherit Production env vars on Vercel, so without this guard
 * every preview build would report into the live GA4 property and Clarity
 * project. Vercel injects NEXT_PUBLIC_VERCEL_ENV automatically.
 */
function isMeasurableEnv(): boolean {
  if (process.env.NODE_ENV !== 'production') return false;
  const vercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV;
  return vercelEnv !== 'preview' && vercelEnv !== 'development';
}

function looksLikeGaId(id: string): boolean {
  return /^G-[A-Z0-9]+$/i.test(id);
}

function looksLikeClarityId(id: string): boolean {
  // Clarity project ids are short alphanumeric strings
  return /^[a-z0-9]{8,20}$/i.test(id);
}

function looksLikeUmamiId(id: string): boolean {
  // UUID website id from Umami Cloud
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * The ids that pass their shape check.
 *
 * One source of truth for two questions: what to render, and whether there is
 * anything worth asking consent for. Answering those separately would let the
 * banner appear where nothing would ever load, or — the direction that matters
 * — be skipped on a page that loads a tracker anyway.
 */
function configuredIds() {
  return {
    ga: looksLikeGaId(GA_ID) ? GA_ID : '',
    clarity: looksLikeClarityId(CLARITY_ID) ? CLARITY_ID : '',
    umami: looksLikeUmamiId(UMAMI_ID) ? UMAMI_ID : '',
  };
}

/** Would a yes actually load something? The layout asks before it asks the visitor. */
export function analyticsConfigured(): boolean {
  if (!isMeasurableEnv()) return false;
  const { ga, clarity, umami } = configuredIds();
  return Boolean(ga || clarity || umami);
}

export function Analytics() {
  if (!isMeasurableEnv()) return null;

  // Read on the server so a tracker is never in the document before it is
  // allowed. A client-side suppression would still have shipped the script.
  // Undecided is not consent: readConsent returns null and this refuses.
  if (!analyticsAllowed(cookies().get(CONSENT_COOKIE)?.value)) return null;

  const { ga, clarity, umami } = configuredIds();

  if (!ga && !clarity && !umami) return null;

  return <AnalyticsScripts ga={ga} clarity={clarity} umami={umami} umamiSrc={UMAMI_SRC} />;
}
