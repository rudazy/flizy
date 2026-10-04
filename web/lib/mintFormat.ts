/**
 * Words and times for the Mint screens: status labels, countdowns, schedule
 * lines, and the datetime-local field a creator types a time into. Pure, so
 * the pages and test/mintFormat.test.js share it.
 */

export type MintStatus = 'unconfigured' | 'paused' | 'upcoming' | 'allowlist' | 'public' | 'ended' | 'sold_out' | 'live';

/** The pill on a card or collection header. */
export function statusLabel(status: MintStatus, contractManaged: boolean): string {
  if (contractManaged && status === 'live') return 'Mint live';
  switch (status) {
    case 'public':
    case 'allowlist':
    case 'live':
      return 'Mint live';
    case 'upcoming':
      return 'Upcoming';
    case 'sold_out':
      return 'Sold out';
    case 'ended':
      return 'Mint ended';
    case 'paused':
      return 'Paused';
    default:
      return 'Not set up';
  }
}

export function isLiveStatus(status: MintStatus): boolean {
  return status === 'public' || status === 'allowlist' || status === 'live';
}

/** "04h 21m", "2d 03h", "45s". Never negative. */
export function countdown(targetSec: number, nowSec: number): string {
  let s = Math.max(0, Math.floor(targetSec - nowSec));
  const d = Math.floor(s / 86_400);
  s -= d * 86_400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${pad(h)}h`;
  if (h > 0) return `${pad(h)}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s - m * 60)}s`;
  return `${s}s`;
}

/** "May 12, 18:00 UTC". The schedule is shown in UTC so creator and minters read the same time. */
export function utcLabel(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${month} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** A datetime-local value ("2026-10-12T18:00") read as UTC, to unix seconds; 0 when empty or invalid. */
export function utcInputToSec(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return 0;
  const ms = Date.parse(`${value}:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** Unix seconds to a datetime-local value in UTC. */
export function secToUtcInput(sec: number): string {
  if (!sec) return '';
  return new Date(sec * 1000).toISOString().slice(0, 16);
}

export type ScheduleStep = { key: string; title: string; when: string; state: 'done' | 'live' | 'next' };

/** The timeline under a mint: Allowlist, Public, Mint ends, each marked done, live or still to come. */
export function scheduleSteps(
  c: { allowlistStart: number; allowlistEnd: number; publicStart: number; mintEnd: number },
  nowSec: number
): ScheduleStep[] {
  const steps: ScheduleStep[] = [];
  const ended = c.mintEnd !== 0 && nowSec >= c.mintEnd;
  if (c.allowlistStart !== 0) {
    const state = nowSec >= c.allowlistEnd || ended ? 'done' : nowSec >= c.allowlistStart ? 'live' : 'next';
    steps.push({ key: 'allowlist', title: 'Allowlist', when: `${utcLabel(c.allowlistStart)} to ${utcLabel(c.allowlistEnd)}`, state });
  }
  if (c.publicStart !== 0) {
    const state = ended ? 'done' : nowSec >= c.publicStart ? 'live' : 'next';
    steps.push({ key: 'public', title: 'Public mint', when: utcLabel(c.publicStart), state });
  }
  steps.push({ key: 'end', title: 'Mint ends', when: c.mintEnd ? utcLabel(c.mintEnd) : 'At sellout', state: ended ? 'done' : 'next' });
  return steps;
}
