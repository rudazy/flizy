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
 * Server-only signer for the user's site agent wallet (testnet custody stub).
 * Never expose the private key to WhatsApp or logs.
 * @param {string} accountId
 * @param {import('ethers').Provider} provider
 */
function getAgentSigner(accountId, provider) {
  const w = deriveAgentWallet(accountId);
  return provider ? w.connect(provider) : w;
}

/**
 * Ensure accounts.agent_wallet_address matches the deterministic agent wallet.
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

  const wallet = deriveAgentWallet(accountId);
  const expected = wallet.address;

  if (
    account.agent_wallet_address &&
    ethers.isAddress(account.agent_wallet_address) &&
    ethers.getAddress(account.agent_wallet_address) === expected
  ) {
    return account;
  }

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
    `Credit: ${account.balance_eth ?? 0} ETH`,
    `Agent wallet: ${account.agent_wallet_address || 'pending'}`,
  ].filter(Boolean);

  if (chain && account.agent_wallet_address) {
    const base = (chain.explorerBaseUrl || '').replace(/\/$/, '');
    lines.push(`Explorer: ${base}/address/${account.agent_wallet_address}`);
    lines.push(`Chain: ${chain.name} (${chain.chainId})`);
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
