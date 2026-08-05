/**
 * Per-page metadata builder.
 *
 * Next merges metadata shallowly: a page that declares `openGraph` replaces the
 * parent object outright rather than merging field by field. Building the whole
 * object here keeps every page's card complete (image, siteName, type) instead of
 * silently dropping the inherited fields.
 */

import type { Metadata } from 'next';

/**
 * Declared dimensions must match the real file. public/og.jpg is currently
 * 1280x720; when a purpose-built 1200x630 card ships, update these three values
 * and nothing else needs to change.
 */
export const OG_IMAGE = {
  url: '/og.jpg',
  width: 1280,
  height: 720,
  alt: 'Flizy — send crypto from WhatsApp and Telegram, only to people you trust',
} as const;

type PageMetaInput = {
  /** Full title, used verbatim. Include the brand yourself — the parent template is bypassed. */
  title: string;
  description: string;
  /** Root-relative path, e.g. '/signup'. Resolved against metadataBase. */
  path: string;
  /** Private app surfaces: keep them out of the index but let link equity flow. */
  noindex?: boolean;
};

export function pageMetadata({
  title,
  description,
  path,
  noindex = false,
}: PageMetaInput): Metadata {
  return {
    // Absolute so the '%s | Flizy' template does not double the brand name.
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    robots: noindex ? { index: false, follow: true } : { index: true, follow: true },
    openGraph: {
      type: 'website',
      locale: 'en_US',
      siteName: 'Flizy',
      url: path,
      title,
      description,
      images: [OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      site: '@Flizyapp',
      creator: '@Flizyapp',
      title,
      description,
      images: [OG_IMAGE.url],
    },
  };
}
