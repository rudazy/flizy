/**
 * Move agent wallet funds from the legacy v1 addresses to the v2 addresses.
 *
 * The v1 derivation used the account id alone, so every v1 address is
 * compromised the moment an account id is seen. v2 keys the derivation with
 * WALLET_DERIVATION_SECRET, which changes every address. This script empties
 * the old ones.
 *
 * CMD:
 *   node scripts\sweep-agent-wallets.js                (dry run, reads only)
 *   node scripts\sweep-agent-wallets.js --broadcast    (sends transactions)
 *
 * Dry run is the default and sends nothing. Re-running after a broadcast is
 * safe: addresses with nothing left are skipped.
 *
 * Only the per-account agent wallets derive from the account id, so only these
 * addresses move. The ops pool (PRIVATE_KEY) and the claim escrow
 * (ESCROW_PRIVATE_KEY) are unaffected, and pending claims sit in escrow, not in
 * agent wallets.
 */

require('dotenv').config();
const { ethers } = require('ethers');

const { requireEnv } = require('../lib/config');
const { getDefaultChain, explorerTxUrl } = require('../lib/chains');
const { getSupabase } = require('../lib/supabase');
const {
  deriveAgentWallet,
  deriveLegacyWalletV1,
  deriveLegacyAddressV1,
} = require('../lib/agentWallet');

requireEnv(['SUPABASE_URL', 'SUPABASE_KEY', 'WALLET_DERIVATION_SECRET']);

const BROADCAST = process.argv.includes('--broadcast');

// ERC-20s swept off each old address. FLZ comes from the chain registry.
// Add more token addresses here as they are listed.
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

/** Gas headroom left on the old address so the ETH sweep itself can pay. */
const SWEEP_GAS_RESERVE = ethers.parseEther('0.00002');
/** Topped up from ops when an old address holds tokens but no gas. */
const GAS_TOPUP = ethers.parseEther('0.0002');

function fmt(wei) {
  return ethers.formatEther(wei);
}

function pad(value, width) {
  const s = String(value);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

async function listAccounts() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('accounts')
    .select('id, email, agent_wallet_address')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`accounts read failed: ${error.message}`);
  return data || [];
}

/**
 * Read what is sitting on one legacy address.
 */
async function inspect(account, provider, tokens) {
  const oldAddress = deriveLegacyAddressV1(account.id);
  const newAddress = deriveAgentWallet(account.id).address;

  const ethWei = await provider.getBalance(oldAddress);
  const tokenBalances = [];
  for (const token of tokens) {
    const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
    try {
      const raw = await contract.balanceOf(oldAddress);
      if (raw > 0n) {
        tokenBalances.push({ ...token, raw });
      }
    } catch (err) {
      console.warn(`  token read failed ${token.symbol} on ${oldAddress}: ${err.message || err}`);
    }
  }

  return { account, oldAddress, newAddress, ethWei, tokenBalances };
}

/**
 * Empty one legacy address: tokens first, then remaining ETH.
 */
async function sweepOne(row, provider, chain, opsWallet) {
  const { account, oldAddress, newAddress, ethWei, tokenBalances } = row;
  const signer = deriveLegacyWalletV1(account.id).connect(provider);

  if (signer.address !== oldAddress) {
    throw new Error(`legacy signer mismatch for ${account.id}`);
  }

  let gasWei = ethWei;

  // Tokens cannot move without gas on the old address.
  if (tokenBalances.length && gasWei < GAS_TOPUP) {
    if (!opsWallet) {
      console.log('  skip tokens: no ops wallet available to fund gas');
    } else {
      console.log(`  funding gas ${fmt(GAS_TOPUP)} ETH from ops`);
      const fund = await opsWallet.sendTransaction({ to: oldAddress, value: GAS_TOPUP });
      const fundReceipt = await fund.wait(1);
      if (!fundReceipt || fundReceipt.status !== 1) {
        throw new Error('gas top-up failed');
      }
      console.log(`  gas tx ${explorerTxUrl(chain, fund.hash)}`);
      gasWei = await provider.getBalance(oldAddress);
    }
  }

  for (const token of tokenBalances) {
    const contract = new ethers.Contract(token.address, ERC20_ABI, signer);
    console.log(`  sending ${token.display} ${token.symbol}`);
    const tx = await contract.transfer(newAddress, token.raw);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`${token.symbol} transfer failed`);
    }
    console.log(`  ${token.symbol} tx ${explorerTxUrl(chain, tx.hash)}`);
  }

  // Remaining ETH minus the cost of this last transaction.
  //
  // GIWA is an OP-stack L2, so the real cost is execution gas plus an L1 data
  // fee that getFeeData does not report. Keep back a multiple of the execution
  // estimate: leaving a little dust on a dead address is harmless, while
  // underestimating means the sweep reverts for insufficient funds.
  const balanceNow = await provider.getBalance(oldAddress);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 0n;
  const gasCost = gasPrice * 21000n * 4n;
  const keepBack = gasCost > SWEEP_GAS_RESERVE ? gasCost : SWEEP_GAS_RESERVE;

  if (balanceNow <= keepBack) {
    console.log(`  no ETH left to sweep (${fmt(balanceNow)} ETH, fee ~${fmt(keepBack)})`);
    return;
  }

  const value = balanceNow - keepBack;
  console.log(`  sending ${fmt(value)} ETH`);
  const tx = await signer.sendTransaction({ to: newAddress, value });
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error('ETH sweep failed');
  }
  console.log(`  ETH tx ${explorerTxUrl(chain, tx.hash)}`);
}

async function main() {
  const chain = getDefaultChain();
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);

  const tokens = [];
  if (chain.flzToken) {
    tokens.push({ symbol: 'FLZ', address: ethers.getAddress(chain.flzToken), decimals: 18 });
  }

  const accounts = await listAccounts();

  console.log('');
  console.log(`Flizy agent wallet sweep  v1 -> v2`);
  console.log(`Chain:    ${chain.name} (${chain.chainId})`);
  console.log(`Tokens:   ${tokens.map((t) => t.symbol).join(', ') || 'none'}`);
  console.log(`Accounts: ${accounts.length}`);
  console.log(`Mode:     ${BROADCAST ? 'BROADCAST (sends transactions)' : 'DRY RUN (reads only)'}`);
  console.log('');

  const rows = [];
  for (const account of accounts) {
    rows.push(await inspect(account, provider, tokens));
  }

  console.log(
    `${pad('ACCOUNT', 38)} ${pad('OLD (v1)', 44)} ${pad('NEW (v2)', 44)} ${pad('ETH', 14)} TOKENS`
  );
  console.log('-'.repeat(160));

  let fundedCount = 0;
  let totalEth = 0n;

  for (const row of rows) {
    for (const token of row.tokenBalances) {
      token.display = ethers.formatUnits(token.raw, token.decimals);
    }
    const tokenText = row.tokenBalances.length
      ? row.tokenBalances.map((t) => `${t.display} ${t.symbol}`).join(', ')
      : '-';
    const hasFunds = row.ethWei > 0n || row.tokenBalances.length > 0;
    if (hasFunds) {
      fundedCount += 1;
      totalEth += row.ethWei;
    }
    console.log(
      `${pad(row.account.id, 38)} ${pad(row.oldAddress, 44)} ${pad(row.newAddress, 44)} ${pad(
        fmt(row.ethWei),
        14
      )} ${tokenText}`
    );
  }

  console.log('-'.repeat(160));
  console.log(`Old addresses holding funds: ${fundedCount} of ${rows.length}`);
  console.log(`Total ETH on old addresses:  ${fmt(totalEth)}`);
  console.log('');

  if (!BROADCAST) {
    console.log('Dry run only. Nothing was sent.');
    console.log('To move the funds: node scripts\\sweep-agent-wallets.js --broadcast');
    return;
  }

  requireEnv(['PRIVATE_KEY']);
  const opsWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log(`Ops wallet (gas top-ups): ${opsWallet.address}`);
  console.log('');

  let swept = 0;
  let failed = 0;

  for (const row of rows) {
    const hasFunds = row.ethWei > 0n || row.tokenBalances.length > 0;
    if (!hasFunds) continue;

    console.log(`Account ${row.account.id}`);
    console.log(`  ${row.oldAddress} -> ${row.newAddress}`);
    try {
      await sweepOne(row, provider, chain, opsWallet);
      swept += 1;
    } catch (err) {
      failed += 1;
      console.error(`  FAILED: ${err.message || err}`);
    }
    console.log('');
  }

  console.log(`Swept ${swept}, failed ${failed}.`);
  console.log('Re-run without --broadcast to confirm the old addresses are empty.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
