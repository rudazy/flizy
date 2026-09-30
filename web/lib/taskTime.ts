/**
 * How a task's clock is shown.
 *
 * The database stores one instant. These formatters turn it into the words on
 * a card or a page. They take the zone and the clock as arguments so a test
 * can pin them; the component that calls them supplies the viewer's zone.
 */

export function formatTaskDate(iso: string, timeZone: string, locale?: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(ms);
}

export function formatTaskInstant(iso: string, timeZone: string, locale?: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  // dateStyle cannot be combined with timeZoneName. The zone is the part a
  // reader needs, so the fields are spelled out instead.
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(ms);
}

/** Detail page. "2d 14h remaining", or "Ended" once the instant has passed. */
export function formatRemaining(iso: string, now: number): string {
  const end = new Date(iso).getTime();
  if (!Number.isFinite(end)) return '';
  const ms = end - now;
  if (ms <= 0) return 'Ended';

  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes % 60;

  if (days >= 1) return `${days}d ${hours}h remaining`;
  if (hours >= 1) return `${hours}h ${minutes}m remaining`;
  return `${Math.max(1, minutes)}m remaining`;
}

/**
 * Discovery card. Coarse on purpose: a card that counts minutes invites a
 * glance every few seconds, and the number is stale the moment it renders.
 */
export function formatCardEnds(
  iso: string,
  state: 'live' | 'review' | 'completed' | 'cancelled',
  now: number
): string {
  if (state === 'completed') return 'Completed';
  if (state === 'cancelled') return 'Cancelled';
  if (state === 'review') return 'Under review';

  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'Closing';

  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `Ends in ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Ends in ${hours}h`;
  return `Ends in ${Math.floor(hours / 24)}d`;
}
