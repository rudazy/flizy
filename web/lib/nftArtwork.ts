/**
 * Artwork shipped with the site for collections Flizy lists, by ticker. Used
 * where a collection has no artwork of its own on record (Giwaforge's
 * tokenURI is empty). Pure, safe on the client.
 */
const LISTED_ARTWORK: Record<string, string> = {
  giwaforge: '/explore/nft-giwaforge.png',
};

/** The collection's own image, else the shipped artwork for its ticker, else null (a drawn tile). */
export function artworkFor(imageUrl: string | null, ticker: string | null | undefined): string | null {
  return imageUrl ?? (ticker ? LISTED_ARTWORK[ticker] ?? null : null);
}
