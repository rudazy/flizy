'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/**
 * The last boundary. A render error thrown above every other boundary, in the
 * root layout itself, replaces the whole document, so this file supplies its
 * own html and body: nothing from app/layout.tsx is around it, which is also
 * why the styling here is inline rather than the usual classes.
 *
 * It exists mainly to report. React render errors in the App Router reach
 * Sentry through nothing else, and the SDK warns at build time when this file
 * is missing. Reporting is a no-op unless instrumentation-client.ts actually
 * started the SDK, so a local crash still stays local.
 *
 * What it deliberately does NOT do is show the error. `error.message` on a
 * money app can hold an address, an amount or whatever a failed call echoed
 * back, and this page is the one screen guaranteed to be reachable by someone
 * who is not logged in. The digest is Next's own correlation id, safe to show
 * and the thing that ties a report to what the user saw.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      {/*
        Written out by hand because this component replaces the document: the
        root layout is gone, and with it the viewport and metadata it exports.
        Without the viewport tag a phone lays this out at desktop width and the
        text arrives unreadable, which is a poor way to apologise for a crash.
      */}
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>Something broke | Flizy</title>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b0a09',
          color: '#f2ebe1',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          padding: '24px',
        }}
      >
        <main style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <p
            style={{
              margin: 0,
              fontSize: '0.75rem',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: '#e0b84a',
            }}
          >
            Flizy
          </p>
          <h1 style={{ margin: '0.75rem 0 0', fontSize: '1.5rem', fontWeight: 500 }}>
            Something broke on our side
          </h1>
          <p style={{ margin: '1rem 0 0', lineHeight: 1.6, color: '#8f877c' }}>
            Your money is not affected. Nothing was sent or changed by this. Reload the page,
            or check your balance in WhatsApp or Telegram.
          </p>
          {error.digest ? (
            <p style={{ margin: '1.5rem 0 0', fontSize: '0.75rem', color: '#8f877c' }}>
              Reference {error.digest}
            </p>
          ) : null}
          <p style={{ margin: '1.75rem 0 0' }}>
            <a
              href="/"
              style={{
                display: 'inline-block',
                padding: '0.7rem 1.15rem',
                border: '1px solid #3a322a',
                borderRadius: '4px',
                color: '#f2ebe1',
                textDecoration: 'none',
              }}
            >
              Back to home
            </a>
          </p>
        </main>
      </body>
    </html>
  );
}
