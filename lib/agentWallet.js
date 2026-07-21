/**
 * Agent wallet pointer on the permanent account (custody-agnostic stub).
 * Address is deterministic from account id so the same account always shows
 * the same address. Private key material is never sent to WhatsApp.
 *
 * Phase 2 replaces this with CREATE2 smart-wallet deploy; address field stays.
 */

const { ethers } = require('ethers');
const { getSupabase } = require('./supabase');

/**
 * Deterministic testnet agent key from account id (server-only).
 * @param {string} accountId
 */
function deriveAgentWallet(accountId) {
  const material = ethers.keccak256(ethers.toUtf8Bytes(`flizy:agent:v1:${accountId}`));
  return new ethers.Wallet(material);
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

  // Keep permanent address if already set
  if (account.agent_wallet_address && ethers.isAddress(account.agent_wallet_address)) {
    const stored = ethers.getAddress(account.agent_wallet_address);
    // If stored matches derivation, perfect. If not, still keep stored (funds may be there)
    // but prefer expected for new accounts only.
    if (stored === expected) {
      return account;
    }
    // Legacy mismatch: do not rotate; return as-is and log once
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
  getAgentSigner,
  ensureAgentWallet,
  getAccountWithWallet,
  formatAccountWalletCard,
};
