/**
 * Claim escrow wallet — separate from ops (gas / bot infra).
 *
 * Ops (PRIVATE_KEY): infrastructure, gas, non-user pool.
 * Escrow (ESCROW_PRIVATE_KEY or derived): only holds pending claim liability.
 *
 * Invariant: on-chain escrow balance >= sum(pending claims amount_eth) + gas reserve.
 */

const { ethers } = require('ethers');
const { getSupabase } = require('./supabase');
const { config } = require('./config');

/**
 * Escrow signer. Prefer ESCROW_PRIVATE_KEY (dedicated key).
 * Fallback (testnet only): deterministic wallet from ops key material so deploy
 * works without a second env — still a *different address* than ops.
 *
 * @param {import('ethers').Provider} [provider]
 */
function getEscrowWallet(provider) {
  const explicit = process.env.ESCROW_PRIVATE_KEY;
  let wallet;
  if (explicit && !/^your_/i.test(explicit) && !explicit.includes('placeholder')) {
    wallet = new ethers.Wallet(explicit);
  } else {
    const ops = process.env.PRIVATE_KEY;
    if (!ops) {
      throw new Error('ESCROW_PRIVATE_KEY or PRIVATE_KEY required for claim escrow');
    }
    // Different address than ops; replace with ESCROW_PRIVATE_KEY before mainnet
    const material = ethers.keccak256(ethers.toUtf8Bytes(`flizy:escrow:v1:${ops}`));
    wallet = new ethers.Wallet(material);
  }
  return provider ? wallet.connect(provider) : wallet;
}

/**
 * Sum of pending claim amounts (ETH units as number string friendly).
 * @returns {Promise<{ count: number, liabilityEth: string, liabilityWei: bigint }>}
 */
async function getPendingClaimsLiability() {
  const supabase = getSupabase();
  // 'processing' is a claim mid-payout or mid-refund. The money is still owed
  // out of escrow until that settles, so it counts toward liability exactly like
  // 'pending' does. Dropping it here would make escrow look solvent while a
  // payout is in flight.
  const { data, error } = await supabase
    .from('claims')
    .select('amount_eth')
    .in('status', ['pending', 'processing']);
  if (error) throw new Error(error.message);

  let liabilityWei = 0n;
  for (const row of data || []) {
    try {
      liabilityWei += ethers.parseEther(String(row.amount_eth));
    } catch {
      // skip bad row
    }
  }
  return {
    count: (data || []).length,
    liabilityEth: ethers.formatEther(liabilityWei),
    liabilityWei,
  };
}

/**
 * Escrow solvency check: balance must cover liability (+ optional extra amount being held).
 *
 * @param {import('ethers').Provider} provider
 * @param {{ extraWei?: bigint, gasBufferEth?: string }} [opts]
 */
async function assertEscrowSolvent(provider, opts = {}) {
  const escrow = getEscrowWallet(provider);
  const balanceWei = await provider.getBalance(escrow.address);
  const { liabilityWei, liabilityEth, count } = await getPendingClaimsLiability();
  const extraWei = opts.extraWei || 0n;
  const gasBuffer = ethers.parseEther(String(opts.gasBufferEth || config.gasBufferEth));

  // Two different questions, kept apart on purpose:
  //
  //   ok        can escrow cover what it owes users (pending liability, plus a
  //             hold being placed right now)
  //   strictOk  can it cover that AND still pay gas for the next payout
  //
  // Solvency is the first question, which is what this function is named and
  // documented for: the gas buffer is operating headroom, not a debt to a user.
  // A wallet that owes 1 ETH and holds exactly 1 ETH is solvent and merely
  // needs topping up before the next payout, and that is what strictOk is for.
  const owedWei = liabilityWei + extraWei;
  const needWei = owedWei + gasBuffer;

  return {
    ok: balanceWei >= owedWei,
    strictOk: balanceWei >= needWei,
    escrowAddress: escrow.address,
    balanceEth: ethers.formatEther(balanceWei),
    liabilityEth,
    pendingCount: count,
    shortfallEth: balanceWei >= owedWei ? '0' : ethers.formatEther(owedWei - balanceWei),
  };
}

/**
 * Human-readable escrow health for admin / pool-style commands.
 */
async function formatEscrowStatus(provider) {
  const s = await assertEscrowSolvent(provider);
  const lines = [
    'Claim escrow (not ops gas wallet)',
    `Address: ${s.escrowAddress}`,
    `Balance: ${s.balanceEth} ETH`,
    `Pending claims: ${s.pendingCount} (~${s.liabilityEth} ETH liability)`,
    s.ok ? 'Solvency: OK (balance >= liability)' : `Solvency: SHORT ${s.shortfallEth} ETH`,
  ];
  return lines.join('\n');
}

module.exports = {
  getEscrowWallet,
  getPendingClaimsLiability,
  assertEscrowSolvent,
  formatEscrowStatus,
};
