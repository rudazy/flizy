/**
 * The one state machine for Flizy Pay API payments and payouts.
 *
 * The database enforces it: api_transition() in
 * supabase/migrations/20261104120000_api_foundation.sql refuses any move not
 * listed here and writes the move's webhook event in the same transaction. This
 * file mirrors that list for the app, and test/apiFoundation.test.js keeps the
 * two equal.
 *
 * `accepted` means Flizy took the request. It is never a completed payment, and
 * nothing may show or report it as one; only `confirmed` and `refunded` are.
 *
 * No imports, so node --test loads this file directly.
 */

export const API_STATES = [
  'accepted',
  'queued',
  'submitted',
  'confirmed',
  'claim_pending',
  'failed',
  'expired',
  'refund_pending',
  'refunded',
] as const;

export type ApiState = (typeof API_STATES)[number];

/** Where each state may go next. A state with no entry is final. */
export const API_TRANSITIONS: Readonly<Record<ApiState, readonly ApiState[]>> = {
  accepted: ['queued', 'submitted', 'expired', 'failed'],
  queued: ['submitted', 'failed'],
  submitted: ['confirmed', 'claim_pending', 'failed'],
  claim_pending: ['confirmed', 'expired', 'refund_pending'],
  expired: ['refund_pending'],
  refund_pending: ['refunded'],
  confirmed: [],
  failed: [],
  refunded: [],
};

export function isApiState(value: unknown): value is ApiState {
  return typeof value === 'string' && (API_STATES as readonly string[]).includes(value);
}

export function canTransition(from: ApiState, to: ApiState): boolean {
  return API_TRANSITIONS[from].includes(to);
}

export function isFinal(state: ApiState): boolean {
  return API_TRANSITIONS[state].length === 0;
}

/** Money reached its destination, or came back. Nothing else counts as completed. */
export function isCompleted(state: ApiState): boolean {
  return state === 'confirmed' || state === 'refunded';
}
