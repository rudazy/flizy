/**
 * Content-Security-Policy for every response.
 *
 * The development bundle is compiled with eval-source-map. A script-src that
 * forbids eval makes the browser discard that bundle: the server HTML still
 * paints, but no event handler is attached, and a submit falls through to a
 * navigation that looks like a refresh. Production builds do not use eval, so
 * the deployed policy does not allow it.
 */

export function sentryIngestOrigin(dsn) {
  const value = String(dsn || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    // A javascript: or data: value parses, and its origin is the literal
    // "null", which would be emitted into connect-src as a bare token. An
    // http: value would name a plaintext endpoint inside a policy that ends
    // in upgrade-insecure-requests.
    if (url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

/**
 * Hosts for passkey, email, Google, and guest accounts.
 * The door does not connect an external wallet, so WalletConnect and
 * WalletLink are not allowed. No captcha, Telegram, or funding hosts.
 * No script host: the SDK is bundled.
 * https://docs.privy.io/security/implementation-guide/content-security-policy
 */
const PRIVY_FRAMES = ['https://auth.privy.io'];

const PRIVY_CONNECT = [
  'https://auth.privy.io',
  'https://*.rpc.privy.systems',
  'https://sepolia-rpc.giwa.io',
];

/** Same shape as custodyDoorAppId. A junk value must not open the policy. */
export function privyDoorRequested(value) {
  return /^[A-Za-z0-9_-]{8,128}$/.test(String(value || '').trim());
}

export function contentSecurityPolicy({ dev, dsn, privy = false }) {
  const sentryOrigin = sentryIngestOrigin(dsn);
  const scriptSrc = [
    "script-src 'self' 'unsafe-inline'",
    dev ? "'unsafe-eval'" : '',
    'https://www.googletagmanager.com https://www.clarity.ms',
  ]
    .filter(Boolean)
    .join(' ');

  const connectExtra = [sentryOrigin, privy ? PRIVY_CONNECT.join(' ') : ''].filter(Boolean).join(' ');

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    // 'unsafe-inline' is required by Next's inline bootstrap and the gtag/clarity snippets.
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    // https: because NFT art lives on whatever host each collection's metadata
    // names (web/lib/nftIndex.ts safeImageUrl). Images cannot run script, and
    // http is still refused by upgrade-insecure-requests below.
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self' https://www.google-analytics.com https://*.clarity.ms${
      connectExtra ? ` ${connectExtra}` : ''
    }`,
    // Absent unless the door is on, so default-src 'self' still blocks frames.
    privy ? `frame-src ${PRIVY_FRAMES.join(' ')}` : '',
    "manifest-src 'self'",
    "worker-src 'self'",
    'upgrade-insecure-requests',
  ]
    .filter(Boolean)
    .join('; ');
}

/** Passkeys run inside Privy's iframe, so that origin needs an explicit allow. */
export function permissionsPolicy({ privy = false } = {}) {
  const base = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';
  if (!privy) return base;
  return `${base}, publickey-credentials-get=(self "https://auth.privy.io"), publickey-credentials-create=(self "https://auth.privy.io")`;
}
