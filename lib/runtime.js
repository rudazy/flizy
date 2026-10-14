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
const schemaGuard = require('./schemaGuard');
const { reportSchemaExposure } = require('./sentry');

// WALLET_DERIVATION_SECRET is checked here so a missing secret stops the process
// at boot rather than mid-payment. Same value must be set on the site.
requireEnv([
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'GIWA_RPC',
  'PRIVATE_KEY',
  'WALLET_DERIVATION_SECRET',
]);

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

/**
 * Verify the database actually has every object this build depends on.
 *
 * requireEnv above stops a missing secret at boot; this stops a missing
 * migration at boot, for the same reason. Async, so entrypoints await it before
 * starting a client rather than it running at module scope.
 *
 * Rejects with a formatted operator message. No bypass.
 *
 * Exposure (anything in public that anon, authenticated or PUBLIC can reach)
 * does not stop the process: stopping a bot does not close a hole in the
 * database, it only adds an outage. It is logged loudly and sent to Sentry
 * under alert=schema_exposure instead.
 */
async function assertSchema() {
  const result = await schemaGuard.assertSchema(supabase);
  schemaGuard.reportExposure(result.exposure, {
    log: console.log,
    warn: console.error,
    report: reportSchemaExposure,
  });
  return result;
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
  assertSchema,
};
