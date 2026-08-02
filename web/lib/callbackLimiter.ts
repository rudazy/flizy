/**
 * Per-route limiter for the OAuth callback.
 *
 * Database-backed on purpose. The obvious implementation is a Map in module
 * scope, and on Vercel that enforces nothing: every serverless instance keeps
 * its own copy, instances come and go between requests, and a caller spreading
 * requests across them is never counted. A limiter that does not limit is worse
 * than none, because it reads as protection.
 *
 * Keyed on the session rather than the account, because a callback can be
 * refused before any account is resolved (bad state, failed token exchange) and
 * those attempts are exactly the ones worth counting.
 *
 * Uses the same escalating ladder as the PIN, the link code and the bind, so
 * there is one shape of "you have been refused too often" across the product.
 */

import { getSupabase } from './supabase';
import { lockoutMsForAttempts, formatWait, lockStateFrom } from './channelBind.ts';

const TABLE = 'oauth_callback_attempts';

function isMissingRelation(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  const code = String(e?.code || '');
  const message = String(e?.message || '');
  return code === '42P01' || code === 'PGRST205' || /does not exist/i.test(message);
}

export type LimitState = {
  locked: boolean;
  retryAfterText: string | null;
  retryAfterMs: number;
};

const OPEN: LimitState = { locked: false, retryAfterText: null, retryAfterMs: 0 };

/**
 * Is this session currently refused? Call before doing any work in the callback.
 *
 * A missing table degrades open with a loud warning, matching how the link-code
 * limiter behaves when its migration has not been applied. The OAuth proof is
 * still the primary defence.
 */
export async function callbackLimitState(sessionKey: string): Promise<LimitState> {
  if (!sessionKey) return OPEN;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(TABLE)
    .select('locked_until')
    .eq('session_key', sessionKey)
    .maybeSingle();

  if (error) {
    if (isMissingRelation(error)) {
      console.warn(
        `[oauth] ${TABLE} missing. Callback rate limiting is NOT active. Run migration 20260802170000_identity_bind_attempts.sql`
      );
      return OPEN;
    }
    console.warn(`[oauth] limiter read failed: ${error.message}`);
    return OPEN;
  }

  const state = lockStateFrom(data?.locked_until);
  return {
    locked: state.locked,
    retryAfterMs: state.remainingMs,
    retryAfterText: state.locked ? formatWait(state.remainingMs) : null,
  };
}

/** Count one refused callback. */
export async function recordCallbackFailure(sessionKey: string): Promise<void> {
  if (!sessionKey) return;

  const supabase = getSupabase();
  const { data, error: readErr } = await supabase
    .from(TABLE)
    .select('failed_attempts')
    .eq('session_key', sessionKey)
    .maybeSingle();

  if (readErr && isMissingRelation(readErr)) return;

  const attempts = Number(data?.failed_attempts || 0) + 1;
  const lockedForMs = lockoutMsForAttempts(attempts);

  const patch: Record<string, unknown> = {
    session_key: sessionKey,
    failed_attempts: attempts,
    last_attempt_at: new Date().toISOString(),
  };
  if (lockedForMs > 0) patch.locked_until = new Date(Date.now() + lockedForMs).toISOString();

  const { error } = await supabase.from(TABLE).upsert(patch, { onConflict: 'session_key' });
  if (error && !isMissingRelation(error)) {
    console.warn(`[oauth] limiter write failed: ${error.message}`);
  }
}

/** A completed round trip clears the counter. */
export async function clearCallbackFailures(sessionKey: string): Promise<void> {
  if (!sessionKey) return;
  const supabase = getSupabase();
  const { error } = await supabase
    .from(TABLE)
    .update({ failed_attempts: 0, locked_until: null })
    .eq('session_key', sessionKey);
  if (error && !isMissingRelation(error)) {
    console.warn(`[oauth] limiter clear failed: ${error.message}`);
  }
}
