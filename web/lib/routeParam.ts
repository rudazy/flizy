/**
 * A dynamic route segment as the person typed it.
 *
 * Next hands the segment over still URL-encoded, so a Flizy number typed with
 * spaces arrives as "961%20702%20160", and stripping non-digits from that keeps
 * the 20s. A malformed escape is returned as it came rather than throwing.
 */
export function decodeRouteParam(value: unknown): string {
  const raw = String(value ?? '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
