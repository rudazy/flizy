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
 * Hosts Privy needs, from its guide:
 * https://docs.privy.io/security/implementation-guide/content-security-policy
 *
 * Privy connects the visitor's own wallet for wallet mode
 * (components/ExternalWalletProvider.tsx): WalletConnect (relay, wallet list,
 * verify frame) and Coinbase Wallet (walletlink relay). No captcha, Telegram,
 * or funding hosts: nobody logs in through Privy and nothing is bought. No
 * script host: the SDK is bundled.
 */
const PRIVY_FRAMES = ['https://auth.privy.io', 'https://verify.walletconnect.com', 'https://verify.walletconnect.org'];

/**
 * The chain's public RPC, which the browser reads directly whenever a
 * visitor's own wallet is in use: balances and receipts in wallet mode, Account
 * > Wallets, and outside-wallet pay. Needed with or without Privy, since the
 * browser-wallet fallback reads it too (web/lib/walletChain.ts).
 */
const CHAIN_RPC = 'https://sepolia-rpc.giwa.io';

const PRIVY_CONNECT = [
  'https://auth.privy.io',
  'https://*.rpc.privy.systems',
  'wss://relay.walletconnect.com',
  'wss://relay.walletconnect.org',
  'wss://www.walletlink.org',
  'https://explorer-api.walletconnect.com',
];

/** Same shape as custodyDoorAppId. A junk value must not open the policy. */
export function privyDoorRequested(value) {
  return /^[A-Za-z0-9]{25}$/.test(String(value || '').trim());
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

  const connectExtra = [CHAIN_RPC, sentryOrigin, privy ? PRIVY_CONNECT.join(' ') : ''].filter(Boolean).join(' ');

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
    // Absent unless Privy is on, so default-src 'self' still blocks frames.
    privy ? `frame-src ${PRIVY_FRAMES.join(' ')}` : '',
    privy ? `child-src ${PRIVY_FRAMES.join(' ')}` : '',
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
