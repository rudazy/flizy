/**
 * Shared process runtime: chain, provider, ops wallet, escrow wallet.
 *
 * Every client entrypoint (WhatsApp, Telegram) loads this so they fail fast on
 * the same env and sign from the same wallets. No client-specific code here.
 */

require('dotenv').config();
const { ethers } = require('ethers');

const { requireEnv } = require('./config');
const { getDefaultChain, explorerTxUrl, explorerAddressUrl } = require('./chains');
const { getSupabase } = require('./supabase');
const { getEscrowWallet } = require('./escrowWallet');

requireEnv(['SUPABASE_URL', 'SUPABASE_KEY', 'GIWA_RPC', 'PRIVATE_KEY']);

const chain = getDefaultChain();
const supabase = getSupabase();
const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);

/** Ops: gas / infra only — never holds user claim escrow */
const opsWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

/** Claim escrow: separate address (ESCROW_PRIVATE_KEY or derived) */
const escrowWallet = getEscrowWallet(provider);

function txUrl(hash) {
  return explorerTxUrl(chain, hash);
}

function addressUrl(address) {
  return explorerAddressUrl(chain, address);
}

async function getOpsBalanceEth() {
  const balanceWei = await provider.getBalance(opsWallet.address);
  return ethers.formatEther(balanceWei);
}

module.exports = {
  chain,
  supabase,
  provider,
  opsWallet,
  escrowWallet,
  txUrl,
  addressUrl,
  getOpsBalanceEth,
};
