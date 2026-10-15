import type { MetadataRoute } from 'next';

function siteOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://flizy.app';
  try {
    return new URL(raw).origin;
  } catch {
    return 'https://flizy.app';
  }
}

export default function robots(): MetadataRoute.Robots {
  const base = siteOrigin();
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // /dashboard is deliberately crawlable but noindex (see app/dashboard/layout.tsx).
        // Blocking it here would hide the noindex directive, and Google would index the
        // URL from the header/footer/homepage links without ever seeing the page.
        // /api/, /claim/ and /a/ stay blocked: claim and approval URLs carry
        // one-time tokens.
        disallow: ['/api/', '/claim/', '/a/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base.replace(/^https?:\/\//, ''),
  };
}
