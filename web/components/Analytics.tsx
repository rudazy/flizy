import Script from 'next/script';

/**
 * Optional GA4 + Microsoft Clarity.
 * Only load when public env ids are set (production Vercel).
 * Never load without an id — keeps local/dev clean.
 */

const GA_ID = (process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || '').trim();
const CLARITY_ID = (process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID || '').trim();

function looksLikeGaId(id: string): boolean {
  return /^G-[A-Z0-9]+$/i.test(id);
}

function looksLikeClarityId(id: string): boolean {
  // Clarity project ids are short alphanumeric strings
  return /^[a-z0-9]{8,20}$/i.test(id);
}

export function Analytics() {
  const ga = looksLikeGaId(GA_ID) ? GA_ID : '';
  const clarity = looksLikeClarityId(CLARITY_ID) ? CLARITY_ID : '';

  if (!ga && !clarity) return null;

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
    </>
  );
}
