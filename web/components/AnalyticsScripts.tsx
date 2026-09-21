'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import Script from 'next/script';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { analyticsAllowedUrl } from '../lib/analyticsRoutes';

/**
 * The tag markup, and the thing that keeps a tag off a private page.
 *
 * Splitting this out of Analytics.tsx buys one specific property: the server
 * half keeps deciding whether analytics may run at all (production, real ids,
 * consent given), and this half decides where. A client component is needed
 * because only the client knows the pathname across a soft navigation, and a
 * soft navigation is exactly how this gets into trouble: SignupForm calls
 * router.push('/dashboard') and LoginForm router.push(next), which defaults to
 * the same place, so the document that loaded on a public page is still the
 * document showing the account.
 *
 * Unmounting a next/script does not unload it. A tag that started on a public
 * page keeps running after React stops rendering it, so leaving the allowlist
 * has to switch the tags off by their own APIs rather than by rendering null.
 *
 * Once off, they stay off for the life of the document. Navigating back to a
 * public page does not restart them. That loses a little measurement and is
 * worth it: a restart path is more code, more states, and every one of its bugs
 * points the same way, at a tag running somewhere it should not.
 */

type Props = {
  ga: string;
  clarity: string;
  umami: string;
  umamiSrc: string;
};

/** Mirrors the shape in lib/analytics.ts, widened for the commands used here. */
type TagWindow = Window & {
  clarity?: (command: string, ...args: unknown[]) => void;
  umami?: { track: (event?: string) => void };
  gtag?: (command: string, ...args: unknown[]) => void;
};

/**
 * Before paint where that exists. The dashboard fetches its balances and
 * addresses after mount, so an effect that runs on mount is already ahead of
 * the data this is protecting, but there is no reason to be later than
 * necessary. useLayoutEffect warns during SSR, hence the swap.
 */
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function stopTags(ga: string): void {
  const w = window as TagWindow;
  // Google's documented kill switch. Set at any point, it blocks every
  // subsequent hit, including any the property's Enhanced Measurement would
  // raise on a history change.
  if (ga) {
    try {
      // The flag is a dynamic key on window rather than a named property, so
      // the index-signature cast is kept to this one line instead of being
      // baked into TagWindow, where it would weaken every other access.
      (window as unknown as Record<string, unknown>)[`ga-disable-${ga}`] = true;
    } catch {
      /* a tag that cannot be switched off must not break the page */
    }
  }
  try {
    w.clarity?.('stop');
  } catch {
    /* same */
  }
  // Umami needs nothing: it is loaded with auto-track off, so it sends only
  // the pageviews this component hands it, and it is about to stop doing that.
}

export function AnalyticsScripts({ ga, clarity, umami, umamiSrc }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The query is part of the decision, not decoration: /login?next=/claim/<token>
  // is an allowlisted path carrying a credential. See lib/analyticsRoutes.ts.
  const allowed = analyticsAllowedUrl(pathname, searchParams?.toString() ?? '');
  const [stopped, setStopped] = useState(false);
  const lastSent = useRef<string | null>(null);

  useBeforePaint(() => {
    if (allowed || stopped) return;
    stopTags(ga);
    setStopped(true);
  }, [allowed, stopped, ga]);

  // Pageviews are sent by hand, never by the tags themselves, so the only paths
  // that can reach Google or Umami are ones that passed the allowlist. Relying
  // on a tag's own SPA tracking would mean trusting a dashboard setting we do
  // not control to keep /claim/<token> out of a hit.
  useEffect(() => {
    if (!allowed || stopped || !pathname) return;
    if (lastSent.current === pathname) return;
    lastSent.current = pathname;

    const w = window as TagWindow;
    try {
      // No params: gtag defaults page_location to the current href, and the
      // allowlist has already established that this href is safe to send.
      // page_path is a Universal Analytics field and GA4 would ignore it.
      w.gtag?.('event', 'page_view');
    } catch {
      /* analytics must never break a page */
    }
    try {
      w.umami?.track();
    } catch {
      /* same */
    }
  }, [pathname, allowed, stopped]);

  if (!allowed || stopped) return null;

  return (
    <>
      {ga ? (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${ga}`}
            strategy="afterInteractive"
          />
          <Script id="ga4-init" strategy="afterInteractive">
            {`
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${ga}', { anonymize_ip: true, send_page_view: false });
`}
          </Script>
        </>
      ) : null}

      {clarity ? (
        <Script id="ms-clarity" strategy="afterInteractive">
          {`
(function(c,l,a,r,i,t,y){
  c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
  t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
  y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
})(window, document, "clarity", "script", "${clarity}");
`}
        </Script>
      ) : null}

      {umami ? (
        <Script
          src={umamiSrc}
          data-website-id={umami}
          data-auto-track="false"
          strategy="afterInteractive"
          defer
        />
      ) : null}
    </>
  );
}
