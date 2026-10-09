/**
 * "A transaction just went through" for the whole app.
 *
 * Any screen that moves money calls announceTx() once the server confirms it.
 * DashboardProvider listens and re-reads balances and history, so the numbers
 * change without a manual Refresh. The chain and the history index can trail
 * the receipt by a few seconds, which is why it reads again after a pause.
 */

export const TX_EVENT = 'flizy:tx';

/** Re-read at once, then after these delays (ms), to catch a slow index. */
export const TX_REFRESH_DELAYS_MS = [0, 4000, 12000] as const;

export function announceTx(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(TX_EVENT));
}
