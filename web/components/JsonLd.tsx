/**
 * Site-wide JSON-LD (Organization + WebSite + SoftwareApplication).
 * Keep sameAs to real public profiles only.
 */

import { ENTITY } from '../lib/entity';
import { PUBLIC_MAIL, publicMail } from '../lib/publicMail';
import { serializeJsonLd } from '../lib/jsonLd';
import { siteOrigin } from '../lib/siteOrigin';

export function JsonLd() {
  const origin = siteOrigin();

  // Public entity edges for Knowledge Graph. Add Discord/GitHub when official URLs exist.
  const sameAs = [
    'https://x.com/Flizyapp',
    // Optional extras via env (comma-separated full URLs)
    ...(process.env.NEXT_PUBLIC_ORG_SAME_AS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//i.test(s)),
  ];

  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${origin}/#organization`,
        name: 'Flizy',
        // The trading name is Flizy; the legal person is the registered
        // company. Both are stated so the entity behind the site is machine
        // readable, matching the footer and the legal pages.
        legalName: ENTITY.legalName,
        email: publicMail('contact').address,
        contactPoint: PUBLIC_MAIL.map((box) => ({
          '@type': 'ContactPoint',
          email: box.address,
          contactType: box.contactType,
        })),
        url: origin,
        logo: {
          '@type': 'ImageObject',
          url: `${origin}/icon-512.png`,
          width: 512,
          height: 512,
        },
        image: `${origin}/og.jpg`,
        sameAs,
        description:
          'Chat wallet for WhatsApp and Telegram. Send crypto only to people you already trust.',
      },
      {
        '@type': 'WebSite',
        '@id': `${origin}/#website`,
        url: origin,
        name: 'Flizy',
        description:
          'Chat wallet for WhatsApp and Telegram. Send crypto only to people you already trust.',
        publisher: { '@id': `${origin}/#organization` },
        inLanguage: 'en',
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${origin}/#app`,
        name: 'Flizy',
        applicationCategory: 'FinanceApplication',
        operatingSystem: 'Web, WhatsApp, Telegram',
        url: origin,
        description:
          'Send crypto from WhatsApp or Telegram to trusted destinations. Manage addresses and unlock PIN on the web dashboard. GIWA-first EVM.',
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
        },
        publisher: { '@id': `${origin}/#organization` },
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(graph) }}
    />
  );
}
