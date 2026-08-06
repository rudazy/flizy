import Script from 'next/script';

/**
 * Optional GA4 + Microsoft Clarity + Umami Cloud.
 * Only load when public env ids are set (production Vercel).
 * Never load without an id — keeps local/dev clean.
 * Preview deploys must not pollute production properties.
 */

const GA_ID = (process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || '').trim();
const CLARITY_ID = (process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID || '').trim();
const UMAMI_ID = (process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID || '').trim();
const UMAMI_SRC = (
  process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL || 'https://cloud.umami.is/script.js'
).trim();

/**
 * Preview deploys inherit Production env vars on Vercel, so without this guard
 * every preview build would report into the live GA4 property and Clarity
 * project. Vercel injects NEXT_PUBLIC_VERCEL_ENV automatically.
 */
function isMeasurableEnv(): boolean {
  if (process.env.NODE_ENV !== 'production') return false;
  const vercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV;
  return vercelEnv !== 'preview' && vercelEnv !== 'development';
}

function looksLikeGaId(id: string): boolean {
  return /^G-[A-Z0-9]+$/i.test(id);
}

function looksLikeClarityId(id: string): boolean {
  // Clarity project ids are short alphanumeric strings
  return /^[a-z0-9]{8,20}$/i.test(id);
}

function looksLikeUmamiId(id: string): boolean {
  // UUID website id from Umami Cloud
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function Analytics() {
  if (!isMeasurableEnv()) return null;

  const ga = looksLikeGaId(GA_ID) ? GA_ID : '';
  const clarity = looksLikeClarityId(CLARITY_ID) ? CLARITY_ID : '';
  const umami = looksLikeUmamiId(UMAMI_ID) ? UMAMI_ID : '';

  if (!ga && !clarity && !umami) return null;

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
gtag('config', '${ga}', { anonymize_ip: true });
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
          src={UMAMI_SRC}
          data-website-id={umami}
          strategy="afterInteractive"
          defer
        />
      ) : null}
    </>
  );
}
