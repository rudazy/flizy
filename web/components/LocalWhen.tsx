'use client';

import { useEffect, useState } from 'react';
import { formatRemaining, formatTaskDate, formatTaskInstant } from '../lib/taskTime';

/**
 * A stored instant, first in UTC, then in the viewer's zone.
 *
 * The first paint is UTC on purpose. Formatting with the browser zone during
 * render disagrees with the server, and the page hydrates with the wrong time
 * or a warning. The effect replaces it once the zone is known.
 */
export function LocalWhen({
  iso,
  kind,
}: {
  iso: string;
  kind: 'date' | 'instant' | 'remaining';
}) {
  const [text, setText] = useState(() => fallback(iso, kind));

  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    if (kind === 'remaining') setText(formatRemaining(iso, Date.now()));
    else if (kind === 'date') setText(formatTaskDate(iso, zone));
    else setText(formatTaskInstant(iso, zone));
  }, [iso, kind]);

  return <time dateTime={iso}>{text}</time>;
}

function fallback(iso: string, kind: 'date' | 'instant' | 'remaining'): string {
  if (kind === 'remaining') return '';
  if (kind === 'date') return formatTaskDate(iso, 'UTC', 'en-US');
  return formatTaskInstant(iso, 'UTC', 'en-US');
}
