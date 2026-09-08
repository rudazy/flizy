/**
 * What may leave this machine when an error is reported. Web half.
 *
 * Mirror of `lib/errorScrub.js`. It exists as a copy for the same reason
 * `web/lib/amountDisplay.ts` does: a client bundle cannot import the root bot
 * package. `test/errorScrubDrift.test.js` pins the two together, because a
 * scrubber that is right in one half and wrong in the other is worse than
 * having only one -- it makes the leak surface the one nobody is looking at.
 *
 * The rule: never send user PII of any kind, wallet keys, API keys or request
 * bodies. Plus the 2026-08-31 identity decision that an account id must never
 * appear in a log; a Sentry event is a log that left the machine.
 */

const SECRET_PATTERNS: RegExp[] = [
  /0x[a-fA-F0-9]{64}/g,
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
  /sk_live_[a-zA-Z0-9]+/gi,
  /service_role/gi,
];

/**
 * Order matters. An email contains a run the phone pattern would chew into, and
 * a 66-character key starts with the same `0x` as a 42-character address, so
 * the longer form is always matched first.
 */
const PII_PATTERNS: Array<[RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '[id]'],
  [/0x[a-fA-F0-9]{64}\b/g, '[redacted]'],
  [/0x[a-fA-F0-9]{40}\b/g, '[address]'],
  // Separators included: an error can echo back what a user typed, so
  // "234-801-234-5678" has to go as well as the bare digits this app stores.
  // Known limit: a short numeric id is not caught, because the threshold that
  // would catch it also eats chain ids and counts. Those arrive in named
  // fields, which DROP_KEYS removes.
  [/\b\d(?:[\s-]?\d){9,14}\b/g, '[phone]'],
];

const DROP_KEYS = new Set([
  'cookies',
  'headers',
  'data',
  'body',
  'request_body',
  'query_string',
  'env',
  'user',
  'ip_address',
  'ip',
  'email',
  'phone',
  'username',
  'account_id',
  'accountId',
  'external_id',
  'externalId',
  'agent_wallet_address',
]);

const MAX_DEPTH = 8;

export function scrubText(text: unknown): string {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  for (const [re, replacement] of PII_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (typeof value !== 'object') return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.has(key)) continue;
    const scrubbed = scrubValue(v, depth + 1);
    if (scrubbed !== undefined) out[key] = scrubbed;
  }
  return out;
}

/**
 * Sentry `beforeSend`. Never returns null on a scrubbing failure: silently
 * dropping reports would make the monitoring lie about how often things break.
 */
export function scrubEvent(event: unknown): Record<string, unknown> {
  try {
    const cleaned = scrubValue(event) as Record<string, unknown>;
    delete cleaned.user;
    delete cleaned.request;
    delete cleaned.server_name;
    return cleaned;
  } catch {
    return {
      message: 'An error was reported but could not be scrubbed, so it was not sent.',
      level: 'error',
    };
  }
}
