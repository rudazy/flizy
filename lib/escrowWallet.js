/**
 * Claim escrow wallet — separate from ops (gas / bot infra).
 *
 * Ops (PRIVATE_KEY): infrastructure, gas, non-user pool.
 * Escrow (ESCROW_PRIVATE_KEY or derived): only holds pending claim liability.
 *
 * Invariant: on-chain native escrow balance >= sum(pending native claims) + gas reserve.
 * Listed-token holds are a separate ERC-20 balance on the same address.
 */

const { ethers } = require('ethers');
const { getSupabase } = require('./supabase');
const { config } = require('./config');

/**
 * Chains on which deriving the escrow key from the ops key is acceptable.
 *
 * Testnets only, listed rather than guessed. A chain absent from this set is
 * refused, which is what makes the paragraph below a rule instead of a wish: the
 * day a second chain is configured, this throws until somebody supplies a real
 * escrow key.
 */
const DERIVED_ESCROW_OK_CHAINS = new Set(['giwa_sepolia']);

/** Said once per process, not per call. */
let warnedAboutDerivedEscrow = false;

/**
 * Escrow signer. Prefer ESCROW_PRIVATE_KEY (dedicated key).
 *
 * The fallback derives the escrow key from the ops key. It yields a different
 * ADDRESS, which is what the header above means by separate, but it does not
 * yield separate CUSTODY: whoever holds PRIVATE_KEY can recompute this key in
 * one line and take every pending claim with it. The two wallets are one secret.
 *
 * That is survivable on a testnet and is not a thing to carry to mainnet, and
 * "replace before mainnet" as a comment is how it would get carried anyway. So
 * the fallback is allowed only on a chain named above, warns once per process
 * when it is used, and refuses everywhere else. Any deployment that relies on it
 * has the ops key as the only secret protecting claim liability.
 *
 * web/lib/claimPayout.ts carries the same rule for claims paid from the site.
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

    const chainKey = String(config.defaultChainKey || '');
    if (!DERIVED_ESCROW_OK_CHAINS.has(chainKey)) {
      throw new Error(
        `ESCROW_PRIVATE_KEY is required on ${chainKey || 'this chain'}. Escrow may only be ` +
          'derived from the ops key on a testnet, because deriving it means one stolen key ' +
          'empties both gas and every pending claim.'
      );
    }

    if (!warnedAboutDerivedEscrow) {
      warnedAboutDerivedEscrow = true;
      console.warn(
        `[escrow] ESCROW_PRIVATE_KEY is not set; the escrow key is derived from the ops key on ${chainKey}. ` +
          'One stolen key empties both. Set a dedicated ESCROW_PRIVATE_KEY.'
      );
    }

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
    .select('amount_eth, asset, token_address')
    .in('status', ['pending', 'processing']);
  if (error) throw new Error(error.message);

  let liabilityWei = 0n;
  let count = 0;
  for (const row of data || []) {
    const asset = String(row.asset || 'ETH').toUpperCase();
    const token = row.token_address;
    if (token || (asset && asset !== 'ETH' && asset !== 'NATIVE' && asset !== 'ETHER')) {
      continue;
    }
    try {
      liabilityWei += ethers.parseEther(String(row.amount_eth));
      count += 1;
    } catch {
      // skip bad row
    }
  }
  return {
    count,
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
