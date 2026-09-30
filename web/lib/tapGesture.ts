/** A second press inside this window is a double tap, not a second single tap. */
export const TAP_WINDOW_MS = 300;

export type TapKind = 'pending' | 'double';

/**
 * Decide a press that follows an earlier one.
 * `elapsedMs` is the time since that earlier press. A first press is not passed here.
 */
export function classifyTap(elapsedMs: number, windowMs = TAP_WINDOW_MS): TapKind {
  if (elapsedMs >= 0 && elapsedMs < windowMs) return 'double';
  return 'pending';
}
