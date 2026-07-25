/**
 * App config. Copy and limits live here so product can tune without logic rewrites.
 */

function envString(key, fallback = '') {
  const v = process.env[key];
  if (v === undefined || v === null || v === '') return fallback;
  return String(v);
}

function envNumber(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  /** Active chain key from registry (lib/chains.js) */
  defaultChainKey: envString('DEFAULT_CHAIN', 'giwa_sepolia'),

  pendingTtlMs: envNumber('PENDING_TTL_MS', 5 * 60 * 1000),
  maxSendEth: envNumber('MAX_SEND_ETH', 0.1),
  /**
   * Default daily send cap (ETH, UTC day) when account.daily_send_limit_eth is null.
   * 0 = no default daily cap (only max per-tx).
   */
  defaultDailySendLimitEth: envNumber('DEFAULT_DAILY_SEND_LIMIT_ETH', 0),
  gasBufferEth: envString('GAS_BUFFER_ETH', '0.0001'),

  botWhatsAppNumber: envString('BOT_WHATSAPP_NUMBER', ''),

  /**
   * Telegram bot username without the @ (for t.me deep links on the site).
   * The bot process discovers its own username from getMe and does not need this.
   */
  telegramBotUsername: envString('TELEGRAM_BOT_USERNAME', '').replace(/^@/, ''),
  /** Long-poll timeout in seconds for getUpdates. */
  telegramPollTimeoutSec: envNumber('TELEGRAM_POLL_TIMEOUT_SEC', 30),
  adminSetupSecret: envString('ADMIN_SETUP_SECRET', ''),
  adminPhones: new Set(
    envString('ADMIN_PHONES', '')
      .split(',')
      .map((p) => p.trim().replace(/^\+/, '').replace(/\D/g, ''))
      .filter(Boolean)
  ),

  /**
   * Low-detail reject when destination is not trusted.
   * Tunable. Points users to the site docs, not internal rules.
   */
  rejectUntrustedCopy: envString(
    'REJECT_UNTRUSTED_COPY',
    'That destination is not allowed. Manage trusted addresses on the Flizy site. See site docs for details.'
  ),

  /** Site base URL (Phase 1+). Used for docs, claim links, wa.me helpers. */
  siteUrl: envString('SITE_URL', 'https://flizy.vercel.app').replace(/\/$/, ''),

  /** Link code lifetime for WhatsApp binding (ms) */
  linkCodeTtlMs: envNumber('LINK_CODE_TTL_MS', 10 * 60 * 1000),

  /** Session unlock inactivity (Phase 4). Default 1 hour. */
  sessionTtlMs: envNumber('SESSION_TTL_MS', 60 * 60 * 1000),

  /**
   * When true, every bot command must start with "flizy " (Phase 4 hardening).
   * Link and unlock always work with the prefix.
   */
  requireFlizyPrefix: envString('REQUIRE_FLIZY_PREFIX', 'true').toLowerCase() !== 'false',

  /** When true, transfers must hit trusted_addresses (Phase 3). */
  enforceTrusted: envString('ENFORCE_TRUSTED', 'true').toLowerCase() !== 'false',

  /**
   * When true, regular users need ledger credit (admin tops up).
   * Default false so anyone can send without an admin barrier (pool must still cover gas+amount).
   */
  enforceCredit: envString('ENFORCE_CREDIT', 'false').toLowerCase() === 'true',

  /** When true, sensitive actions need flizy unlock session. */
  requireUnlock: envString('REQUIRE_UNLOCK', 'true').toLowerCase() !== 'false',

  /** Protocol swap fee (bps). Contract is source of truth on-chain; this is default/display. */
  swapFeeBps: envNumber('SWAP_FEE_BPS', 30),
  /** Default slippage tolerance for swaps (bps). 100 = 1%. */
  swapSlippageBps: envNumber('SWAP_SLIPPAGE_BPS', 100),
  /** Treasury for protocol fee (env; also set on fee router). */
  flizyTreasury: envString(
    'FLIZY_TREASURY',
    '0x81Fb7Ed21B9843D2D5C232A7F3e959F91993401B'
  ),
};

/**
 * Fail fast if required secrets/env are missing or still placeholders.
 * @param {string[]} keys
 */
function requireEnv(keys) {
  const missing = keys.filter((key) => {
    const value = process.env[key];
    if (!value) return true;
    if (/^your_/i.test(value) || value.includes('placeholder')) return true;
    return false;
  });
  if (missing.length > 0) {
    console.error(`Missing or placeholder env vars: ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill real values.');
    process.exit(1);
  }
}

module.exports = {
  config,
  requireEnv,
};
