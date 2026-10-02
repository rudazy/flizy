/**
 * Mainnet ETH price in USD, for the "≈ $" line under NFT prices.
 *
 * GIWA Sepolia ETH has no market price. This is the mainnet rate, shown only as
 * a reference and labelled that way on screen. When the source is down or
 * returns something implausible the figure is null and the line is hidden;
 * nothing ever falls back to a guessed number.
 */

const SOURCE = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';
const TTL_MS = 5 * 60 * 1000;

let cache: { at: number; usd: number | null } | null = null;

export function parseEthUsd(body: unknown): number | null {
  const usd = (body as { ethereum?: { usd?: unknown } } | null)?.ethereum?.usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 1 || usd > 1_000_000) return null;
  return usd;
}

export async function ethUsd(
  fetcher: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }> = (url) =>
    fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) }),
  now = Date.now()
): Promise<number | null> {
  if (cache && now - cache.at < TTL_MS) return cache.usd;
  let usd: number | null = null;
  try {
    const res = await fetcher(SOURCE);
    usd = res.ok ? parseEthUsd(await res.json()) : null;
  } catch {
    usd = null;
  }
  // A failure is cached too, for a minute, so a down source is not hit per request.
  cache = { at: usd == null ? now - TTL_MS + 60_000 : now, usd };
  return usd;
}
