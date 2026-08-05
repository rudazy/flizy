/** Shared origin helper for metadata, sitemap, JSON-LD. */

export function siteOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://flizy.app';
  try {
    return new URL(raw).origin;
  } catch {
    return 'https://flizy.app';
  }
}
