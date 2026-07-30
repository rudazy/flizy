/**
 * One way to answer a client when something failed for a reason the client
 * should not be told.
 *
 * Routes used to do `{ error: err.message }`. A Supabase error message carries
 * table names, column names, constraint names and sometimes the failing value,
 * so a probe against any route returned a partial schema. A thrown ethers or
 * fetch error carries RPC hosts and internal paths the same way.
 *
 * The rule this encodes: a message the code deliberately wrote is fine to send
 * ("Incorrect password", "No LP tokens to remove"), because it was written for
 * the person reading it. A message that came out of a database driver or an
 * exception is not, and is replaced by CLIENT_ERROR_MESSAGE and logged instead.
 *
 * Status codes are unchanged. This is only about the body.
 */

/** What every unexpected failure says. Deliberately says nothing. */
export const CLIENT_ERROR_MESSAGE = 'Something went wrong. Please try again.';

/**
 * An error whose message was written for the user and is safe to send back.
 *
 * Needed where one catch block sees both kinds: lib/trusted.ts throws both
 * "Invalid address" (meant for the person typing it) and a raw Supabase message
 * (never), and the route cannot tell them apart from the string alone.
 */
export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientError';
  }
}

/** Message to show when the error itself is safe, generic otherwise. */
export function clientMessage(err: unknown): string {
  return err instanceof ClientError ? err.message : CLIENT_ERROR_MESSAGE;
}

/**
 * Next's "this route read cookies, so it cannot be static" signal.
 *
 * It is thrown through route handlers during the build as control flow, not as a
 * failure. A catch-all that swallows it turns a framework mechanism into a
 * logged 500 and fills the build output with errors that are not errors, so it
 * has to be rethrown rather than reported.
 */
function isNextDynamicUsage(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { digest?: unknown; name?: unknown };
  return e.digest === 'DYNAMIC_SERVER_USAGE' || e.name === 'DynamicServerError';
}

const SECRET_PATTERNS: RegExp[] = [
  /0x[a-fA-F0-9]{64}/g, // private keys / long hex secrets
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, // JWT-ish
  /sk_live_[a-zA-Z0-9]+/gi,
  /service_role/gi,
];

/**
 * The real message, for the server log only. Mirrors lib/sanitize.js: even our
 * own logs must not carry a key that leaked into an error string.
 */
function describe(err: unknown): string {
  if (!err) return 'unknown error';
  let msg: string;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    msg = String((err as { message?: unknown }).message ?? '');
  } else {
    msg = String(err);
  }
  if (!msg) msg = 'unknown error';
  for (const re of SECRET_PATTERNS) msg = msg.replace(re, '[redacted]');
  return msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
}

/**
 * Postgres / PostgREST error codes are useful in a log line and meaningless to
 * a client, so they go to the log and nowhere else.
 */
function describeCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = String((err as { code?: unknown }).code ?? '');
    if (code) return ` code=${code}`;
  }
  return '';
}

/**
 * Log a failure with enough context to find it, and nothing about it to the
 * caller.
 *
 * @param route stable identifier, e.g. "POST /api/pin"
 * @param err the caught error or a Supabase error object
 * @param context safe identifiers only. An account id is fine (we chose it); a
 *        password, PIN, token or email is not.
 */
export function logApiError(
  route: string,
  err: unknown,
  context: Record<string, string | number | null | undefined> = {}
): void {
  // Rethrown, not logged. See isNextDynamicUsage. This propagates back out of
  // the route's catch block, which is where Next expects it.
  if (isNextDynamicUsage(err)) throw err;

  const extra = Object.entries(context)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.error(`[api] ${route} failed${describeCode(err)}${extra ? ` ${extra}` : ''}: ${describe(err)}`);
}

/**
 * Body for a failure the client gets no detail about. Logs as a side effect, so
 * a route can never return the generic message without leaving a trace behind.
 */
export function apiErrorBody(
  route: string,
  err: unknown,
  context: Record<string, string | number | null | undefined> = {}
): { error: string } {
  logApiError(route, err, context);
  return { error: CLIENT_ERROR_MESSAGE };
}

/**
 * Body for a catch that can see both kinds of error: a ClientError keeps its own
 * wording, anything else is logged and generalised.
 */
export function apiErrorBodyAllowingClientError(
  route: string,
  err: unknown,
  context: Record<string, string | number | null | undefined> = {}
): { error: string } {
  if (err instanceof ClientError) {
    return { error: err.message };
  }
  return apiErrorBody(route, err, context);
}
