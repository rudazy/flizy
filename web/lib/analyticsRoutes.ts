/**
 * Where analytics is allowed to run.
 *
 * `<Analytics />` sits in the root layout, so until this existed it covered
 * every route. That put Clarity session replay on `/dashboard`, where the page
 * renders email addresses, linked phone numbers, the agent wallet address and
 * balances as ordinary text (Clarity's default masking covers input values, not
 * rendered page text, and the mode is a dashboard setting we do not pin), and
 * it put `/claim/<token>` in the path GA4 and Clarity both transmit. The route
 * handler for that token says it "is the credential for that claim and never
 * goes in the log", and robots.txt and the sitemap both exclude `/claim/` for
 * the same reason. The measurement layer went around all three.
 *
 * An ALLOWLIST, not a denylist, and that is the whole point. A denylist has to
 * be remembered every time a route is added, and the one time it is not, the
 * new route is measured by default. Here a route nobody has thought about is
 * private, and someone has to make a deliberate decision to measure it.
 *
 * Exact matches only. `/docs` does not imply `/docs/anything`, so a section
 * added under an allowed path does not inherit permission from its parent.
 */

/**
 * Public pages with nothing account-specific on them.
 *
 * `/login` and `/signup` are in because that is where the signup funnel is
 * measured and neither renders a credential as page text; the password fields
 * are inputs, which Clarity masks by default. Everything under `/dashboard`,
 * `/claim` and `/pay` is deliberately absent.
 */
export const ANALYTICS_PUBLIC_PATHS: readonly string[] = [
  '/',
  '/how-it-works',
  '/docs',
  '/terms',
  '/privacy',
  '/login',
  '/signup',
];

/**
 * Normalise before comparing, so a trailing slash or an empty string cannot be
 * the difference between measured and not. Nothing else is normalised: paths
 * are case-sensitive in Next, and lowercasing here would accept a route the
 * router itself would not serve.
 */
function normalize(pathname: string): string {
  const raw = String(pathname || '').trim();
  if (!raw) return '/';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const noTrailing = withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
  return noTrailing || '/';
}

/** True only for a path explicitly listed above. */
export function analyticsAllowedPath(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string') return false;
  return ANALYTICS_PUBLIC_PATHS.includes(normalize(pathname));
}

/**
 * The path is not the whole URL, and on this site that difference carries a
 * credential.
 *
 * `claim/[token]/page.tsx` sends a signed-out visitor to
 * `/login?next=%2Fclaim%2F<token>` in five places, and `/login` is allowlisted.
 * GA4 defaults `page_location` to the full href and Clarity records the URL
 * itself, so a pathname-only check hands over the exact token the allowlist
 * exists to protect. `/pay` does the same through PayLanding, and DashboardGate
 * through `/login?next=/dashboard/...`.
 *
 * The rule is the allowlist applied twice: any query value that looks like a
 * path has to be a public path too, or the whole URL goes unmeasured. A value
 * that cannot be decoded is refused rather than guessed at.
 */
export function analyticsAllowedUrl(
  pathname: string | null | undefined,
  search: string | null | undefined
): boolean {
  if (!analyticsAllowedPath(pathname)) return false;
  if (!search) return true;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return false;
  }

  for (const value of Array.from(params.values())) {
    // URLSearchParams has already decoded once. The second attempt catches a
    // double-encoded path; a value that throws is refused, not shrugged at.
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return false;
    }

    for (const candidate of [value, decoded]) {
      if (candidate.startsWith('/') && !analyticsAllowedPath(candidate)) return false;
      // Catches a private path reached any other way: absolute URL, extra
      // encoding, a parameter nobody has thought of yet.
      if (/\/(claim|pay|dashboard)(\/|$)/.test(candidate)) return false;
    }
  }

  return true;
}
