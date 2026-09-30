'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A short "Coming soon" note for buttons whose feature is not built yet
 * (search, notifications, Notify me). The button keeps its place and look;
 * tapping it says so instead of doing nothing. Tabs and chips that open a view
 * show a "Coming soon" panel in that view instead.
 *
 * Returns the function a control calls and the note to render once. The note
 * sits in the middle of the screen and is announced to screen readers.
 */
export function useComingSoon(): [(what?: string) => void, JSX.Element] {
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((what?: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(what ? `${what}: coming soon` : 'Coming soon');
    timer.current = setTimeout(() => setMessage(''), 1800);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const note = (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none fixed inset-0 z-[60] flex items-center justify-center px-4 transition-opacity duration-200 ${
        message ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {message ? (
        <span className="rounded-[8px] border border-sun/40 bg-[#141209] px-4 py-2.5 font-sans text-sm font-semibold text-sun shadow-2xl">
          {message}
        </span>
      ) : null}
    </div>
  );

  return [show, note];
}
