'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  CONSENT_COOKIE,
  CONSENT_DENIED,
  CONSENT_GRANTED,
  CONSENT_MAX_AGE_SECONDS,
  type ConsentChoice,
} from '../lib/consent';

/**
 * Analytics consent bar.
 *
 * Only rendered when no choice is stored: the layout reads the cookie on the
 * server and leaves this out entirely once the visitor has answered, so there
 * is no flash of a banner the person already dismissed and no hydration
 * mismatch to paper over.
 *
 * Accept and Reject are the same control with different labels, on purpose.
 * A refusal that costs an extra click, or that is styled as the quiet option,
 * is not a free choice and does not count as one.
 */
export function CookieConsent() {
  const [answered, setAnswered] = useState(false);

  function choose(value: ConsentChoice) {
    const secure = window.location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${CONSENT_COOKIE}=${value}; path=/; max-age=${CONSENT_MAX_AGE_SECONDS}; samesite=lax${secure}`;

    if (value === CONSENT_GRANTED) {
      // The scripts are emitted by a server component, so they are simply not
      // in this document. Reloading is what fetches them. Injecting them from
      // here instead would mean a second copy of the id checks in
      // components/Analytics.tsx, free to drift from the first.
      window.location.reload();
      return;
    }

    setAnswered(true);
  }

  if (answered) return null;

  return (
    <div
      className="consent-bar fixed inset-x-0 z-[60] px-4 pb-4"
      role="region"
      aria-label="Analytics consent"
    >
      <div className="card mx-auto flex max-w-3xl flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between md:p-5">
        <p className="text-sm leading-relaxed text-muted">
          We would like to measure how the site is used, with Google Analytics and Microsoft
          Clarity. They set cookies and Clarity records how pages are used. Nothing loads
          unless you say yes, and the site works either way.{' '}
          <Link href="/privacy#analytics" className="text-paper no-underline hover:text-lime">
            What this collects
          </Link>
        </p>
        <div className="flex shrink-0 gap-3">
          <button type="button" className="btn flex-1 md:flex-none" onClick={() => choose(CONSENT_DENIED)}>
            Reject
          </button>
          <button type="button" className="btn flex-1 md:flex-none" onClick={() => choose(CONSENT_GRANTED)}>
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
