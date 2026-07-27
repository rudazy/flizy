/**
 * Agent wallet pointer on the permanent account (custody-agnostic stub).
 * Address is deterministic from account id so the same account always shows
 * the same address. Private key material is never sent to WhatsApp.
 *
 * Phase 2 replaces this with CREATE2 smart-wallet deploy; address field stays.
 *
 * DERIVATION (v2): the key is HMAC-SHA256 over the account id under a
 * server-only secret, then keccak256 of that MAC. The account id alone is NOT
 * key material. v1 derived the key from the account id with no secret, and that
 * same id also left the server, so anyone who saw an id could rebuild the key
 * offline. v1 survives here only so scripts/sweep-agent-wallets.js can move
 * funds off the old addresses.
 *
 * This derivation is mirrored in web/lib/agentWallet.ts. The two must produce
 * identical addresses. test/agentWallet.test.js and test/webAgentWallet.test.js
 * pin the same vector on both sides.
 */

const crypto = require('crypto');
const { ethers } = require('ethers');
const { getSupabase } = require('./supabase');

const AGENT_LABEL_V2 = 'flizy:agent:v2:';
const AGENT_LABEL_V1 = 'flizy:agent:v1:';
const MIN_SECRET_LENGTH = 32;

/**
 * Server-only secret that turns an account id into key material.
 * Missing or weak secret is fatal: deriving anyway would either hand out a
 * v1-style key (the hole we are closing) or silently create a second address
 * the rest of the system cannot see.
 * @returns {string}
 */
function requireDerivationSecret() {
  const secret = process.env.WALLET_DERIVATION_SECRET || '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `WALLET_DERIVATION_SECRET is required and must be at least ${MIN_SECRET_LENGTH} characters. ` +
        'Agent wallet keys cannot be derived without it. It must be the same value on every ' +
        'process (bot and site) or accounts resolve to different addresses.'
    );
  }
  return secret;
}

/**
 * Agent private key for an account (server-only, never logged or sent to chat).
 * @param {string} accountId
 * @returns {string} 0x-prefixed 32-byte hex
 */
function deriveAgentPrivateKey(accountId) {
  const secret = requireDerivationSecret();
  const mac = crypto
    .createHmac('sha256', secret)
    .update(`${AGENT_LABEL_V2}${accountId}`)
    .digest();
  return ethers.keccak256(mac);
}

/**
 * Deterministic agent wallet for an account (server-only).
 * @param {string} accountId
 */
function deriveAgentWallet(accountId) {
  return new ethers.Wallet(deriveAgentPrivateKey(accountId));
}

/**
 * LEGACY v1 derivation: account id only, no secret.
 *
 * Only scripts/sweep-agent-wallets.js may use this, to read and empty the old
 * addresses. Never derive a live signer from it.
 * @param {string} accountId
 * @returns {string} 0x-prefixed 32-byte hex
 */
function deriveLegacyPrivateKeyV1(accountId) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${AGENT_LABEL_V1}${accountId}`));
}

/**
 * LEGACY v1 wallet. Sweep script only.
 * @param {string} accountId
 */
function deriveLegacyWalletV1(accountId) {
  return new ethers.Wallet(deriveLegacyPrivateKeyV1(accountId));
}

/**
 * LEGACY v1 address. Sweep script, and the pointer migration in
 * ensureAgentWallet that recognises an address our own old code produced.
 * @param {string} accountId
 */
function deriveLegacyAddressV1(accountId) {
  return deriveLegacyWalletV1(accountId).address;
}

/**
 * Ensure agent wallet address is set once and never rotated.
 * Address is always deriveAgentWallet(accountId) so signup, site, and WhatsApp match.
 * Never overwrites an existing address (avoids "new address every time" / lost funds).
 * @param {string} accountId
 */
async function ensureAgentWallet(accountId) {
  const supabase = getSupabase();
  const { data: account, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', accountId)
    .single();
  if (error) throw new Error(error.message);
  if (!account) throw new Error('Account not found');

  const expected = deriveAgentWallet(accountId).address;

  if (account.agent_wallet_address && ethers.isAddress(account.agent_wallet_address)) {
    const stored = ethers.getAddress(account.agent_wallet_address);
    if (stored === expected) {
      return account;
    }

    // A stored v1 address is one our own old code wrote, so the pointer can be
    // moved forward safely: new deposits then land on the v2 address the signer
    // actually controls. Funds already sitting on the v1 address are moved by
    // scripts/sweep-agent-wallets.js, which derives the old address itself and
    // does not read this column, so flipping the pointer first is safe.
    if (stored === deriveLegacyAddressV1(accountId)) {
      const { data: rotated, error: rotErr } = await supabase
        .from('accounts')
        .update({ agent_wallet_address: expected })
        .eq('id', accountId)
        .select('*')
        .single();
      if (rotErr) throw new Error(rotErr.message);
      console.warn(
        `[wallet] account ${accountId} migrated v1 pointer ${stored} to v2 ${expected}; sweep old address`
      );
      return rotated;
    }

    // Unknown address: never rotate, funds may be there. Log once and keep it.
    console.warn(
      `[wallet] account ${accountId} stored ${stored} != derived ${expected}; keeping stored`
    );
    return account;
  }

  // First time only: write permanent agent wallet
  const { data: updated, error: upErr } = await supabase
    .from('accounts')
    .update({ agent_wallet_address: expected })
    .eq('id', accountId)
    .select('*')
    .single();
  if (upErr) throw new Error(upErr.message);
  return updated;
}

/**
 * Signer for account. Uses derivation key (must match ensureAgentWallet for new accounts).
 * If a legacy stored address diverges, still use derivation for testnet (log warning).
 */
function getAgentSigner(accountId, provider) {
  const w = deriveAgentWallet(accountId);
  return provider ? w.connect(provider) : w;
}

/**
 * Load account by id and ensure wallet.
 * @param {string} accountId
 */
async function getAccountWithWallet(accountId) {
  return ensureAgentWallet(accountId);
}

/**
 * Format account summary for WhatsApp (no secrets).
 * @param {object} account
 * @param {import('./chains').ChainConfig} [chain]
 */
function formatAccountWalletCard(account, chain) {
  const lines = [
    'Your Flizy account',
    account.email ? `Email: ${account.email}` : null,
    account.display_name ? `Name: ${account.display_name}` : null,
    `Agent wallet: ${account.agent_wallet_address || 'pending'}`,
  ].filter(Boolean);

  if (chain && account.agent_wallet_address) {
    const base = (chain.explorerBaseUrl || '').replace(/\/$/, '');
    lines.push(`Explorer: ${base}/address/${account.agent_wallet_address}`);
  }

  return lines.join('\n');
}

module.exports = {
  deriveAgentWallet,
  deriveAgentPrivateKey,
  requireDerivationSecret,
  getAgentSigner,
  ensureAgentWallet,
  getAccountWithWallet,
  formatAccountWalletCard,
  // Sweep script only. Nothing else may import these.
  deriveLegacyPrivateKeyV1,
  deriveLegacyWalletV1,
  deriveLegacyAddressV1,
};
