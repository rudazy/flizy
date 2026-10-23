/**
 * Chat sends through a secured account's signed permissions.
 *
 * Once a passkey has signed Flizy's daily permissions (web/lib/custody/ceremony.ts),
 * a plain send of ETH, FLZ or tUSD from chat goes out as the relayer redeeming
 * that permission (DelegationManager.redeemDelegations), not as Flizy's owner
 * key acting on the account. The chain enforces the daily cap either way; this
 * module only decides whether a send fits today's allowance and makes it.
 *
 * Routes, decided before anything is sent:
 *   permission  a live permission for this asset, named for this relayer and
 *               this wallet, with enough of today's allowance left
 *   over_cap    a live permission, but the send is bigger than what is left
 *   owner       anything else: no permission, no relayer key, another wallet
 *
 * A send over the cap is never sent on the owner key: it waits for a passkey
 * approval of that one payment (lib/custody/approvals.js). Until ownership
 * moves to the user, a send the relayer cannot make before broadcasting (no
 * permission, no key, no gas) still goes the old way, so chat never stalls. A
 * send whose outcome is unknown is never retried on the owner path: it raises
 * the same GatorExecError the engine already treats as submitted, so the money
 * cannot move twice.
 */

const { ethers } = require('ethers');
const C = require('./delegations');
const { GatorExecError, classifyBroadcastError } = require('../gatorExecute');
const { publicErrorMessage } = require('../sanitize');

const ENFORCER = new ethers.Interface([
  'function getAvailableAmount(bytes32 _delegationHash, address _delegationManager, bytes _terms) view returns (uint256 availableAmount_, bool isNewPeriod_, uint256 currentPeriod_)',
]);

/** A permission this close to its expiry is left alone: the send could land after it. */
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;
const RECEIPT_TIMEOUT_MS = 90 * 1000;
/** Headroom over the gas estimate, in percent. */
const GAS_HEADROOM = 120n;

/** Raised before anything was broadcast: the caller may safely take the owner path. */
class PermissionNotUsed extends Error {
  constructor(reason) {
    super(`permission not used: ${reason}`);
    this.name = 'PermissionNotUsed';
    this.reason = reason;
  }
}

/** The relayer wallet from CUSTODY_RELAYER_KEY, or null when it is not set. */
function relayerWallet(provider, key = process.env.CUSTODY_RELAYER_KEY) {
  const raw = String(key || '').trim();
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('CUSTODY_RELAYER_KEY must be a 0x-prefixed 32-byte private key');
  return new ethers.Wallet(raw, provider);
}

/** The asset a token address is, among those a permission can carry. */
function symbolForToken(tokenAddress) {
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) return null;
  const a = ethers.getAddress(tokenAddress);
  for (const [symbol, asset] of Object.entries(C.ASSETS)) {
    if (asset.token && asset.token === a) return symbol;
  }
  return null;
}

/** The signed delegation a stored row describes, checked against its own digest. */
function signedFromRow(row) {
  const delegation = {
    delegate: ethers.getAddress(row.delegate),
    delegator: ethers.getAddress(row.gator),
    authority: C.ROOT_AUTHORITY,
    caveats: (row.caveats || []).map((c) => ({ enforcer: ethers.getAddress(c.enforcer), terms: c.terms, args: c.args || '0x' })),
    salt: BigInt(row.salt),
    signature: row.signature,
  };
  if (C.delegationDigest(delegation) !== row.digest) throw new PermissionNotUsed('a stored permission does not match its own digest');
  return { symbol: row.symbol, delegation };
}

async function loadPermission(supabase, accountId, symbol, now) {
  const { data, error } = await supabase
    .from('custody_delegations')
    .select('symbol, gator, delegate, salt, caveats, digest, signature, expires_at')
    .eq('account_id', accountId)
    .eq('symbol', symbol)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !data.signature) return null;
  if (new Date(data.expires_at).getTime() - now.getTime() < EXPIRY_MARGIN_MS) return null;
  return data;
}

/** What is left of today's allowance, as the period enforcer itself reports it. */
async function availableToday(provider, signed) {
  const period = signed.delegation.caveats[0];
  const data = ENFORCER.encodeFunctionData('getAvailableAmount', [
    C.delegationStructHash(signed.delegation),
    C.CONTRACTS.delegationManager,
    period.terms,
  ]);
  const [available] = ENFORCER.decodeFunctionResult('getAvailableAmount', await provider.call({ to: period.enforcer, data }));
  return available;
}

/**
 * Which way a send goes. Reads the database and the chain, sends nothing.
 * @returns {Promise<{route: 'permission'|'over_cap'|'owner', reason?: string, signed?: object, available?: bigint}>}
 */
async function planPermissionSend({ supabase, provider, accountId, wallet, symbol, amount, relayer, now = new Date() }) {
  if (!relayer) return { route: 'owner', reason: 'relayer key unset' };
  if (!C.ASSETS[symbol]) return { route: 'owner', reason: 'asset has no permission' };
  if (typeof amount !== 'bigint' || amount <= 0n) return { route: 'owner', reason: 'amount' };
  const row = await loadPermission(supabase, accountId, symbol, now);
  if (!row) return { route: 'owner', reason: 'no permission' };
  const signed = signedFromRow(row);
  if (signed.delegation.delegate !== relayer.address) return { route: 'owner', reason: 'permission names another relayer' };
  if (signed.delegation.delegator !== ethers.getAddress(wallet)) return { route: 'owner', reason: 'permission is for another wallet' };
  const available = await availableToday(provider, signed);
  if (amount > available) return { route: 'over_cap', signed, available };
  return { route: 'permission', signed, available };
}

/**
 * The relayer redeems the permission. The hash is handed to onBroadcast before
 * the transaction is broadcast, as the owner path does.
 *
 * Throws PermissionNotUsed when nothing reached the chain or the transaction
 * reverted (nothing moved), and GatorExecError('OUTCOME_UNKNOWN', submitted)
 * when it may still confirm.
 */
async function sendWithPermission({ provider, relayer, signed, to, amount, onBroadcast }) {
  const data = C.redeemCalldata(signed, { to, amount });
  let gas;
  try {
    gas = await provider.estimateGas({ from: relayer.address, to: C.CONTRACTS.delegationManager, data });
  } catch (err) {
    throw new PermissionNotUsed(`the permission would refuse this send (${loggable(err)})`);
  }
  const gasLimit = (gas * GAS_HEADROOM) / 100n;
  const fee = await provider.getFeeData();
  const maxFee = fee.maxFeePerGas || fee.gasPrice || 0n;
  if ((await provider.getBalance(relayer.address)) < gasLimit * maxFee) throw new PermissionNotUsed('the relayer is out of gas');

  const populated = await relayer.populateTransaction({ to: C.CONTRACTS.delegationManager, data, gasLimit });
  const signedTx = await relayer.signTransaction(populated);
  const txHash = ethers.keccak256(signedTx);
  if (onBroadcast) {
    try {
      await onBroadcast(txHash);
    } catch (err) {
      throw new PermissionNotUsed(`could not record the send before broadcasting (${loggable(err)})`);
    }
  }

  try {
    await provider.broadcastTransaction(signedTx);
  } catch (err) {
    const kind = classifyBroadcastError(err);
    if (kind === 'rejected') throw new PermissionNotUsed(`the node refused the relayer transaction (${loggable(err)})`);
    if (kind === 'unknown') throw new GatorExecError('OUTCOME_UNKNOWN', 'Relayer broadcast did not answer', { submitted: true, txHash });
    // 'accepted': the node already has it.
  }

  let receipt = null;
  try {
    receipt = await provider.waitForTransaction(txHash, 1, RECEIPT_TIMEOUT_MS);
  } catch {
    receipt = null;
  }
  if (!receipt) throw new GatorExecError('OUTCOME_UNKNOWN', 'No receipt yet for the relayer send', { submitted: true, txHash });
  // A mined revert is final and moved nothing.
  if (receipt.status !== 1) throw new PermissionNotUsed('the relayer transaction reverted');
  return { txHash, receipt };
}

/** Error text safe for a log line: known secret shapes redacted, URLs (which can carry an RPC key) dropped. */
function loggable(err) {
  return publicErrorMessage(err).replace(/https?:\/\/\S+/g, '[url]');
}

/**
 * The whole decision for one chat send: through the permission when it fits;
 * { route: 'over_cap' } when it is bigger than what is left today, so the
 * caller opens a passkey approval instead of sending; otherwise null so the
 * caller takes the owner path. Never returns null after money may have moved.
 *
 * Every return to the owner path logs exactly one warning line with the
 * reason. The line names the asset only: no account, no address, no key.
 * beforeSend runs once the permission route is chosen, just before the relayer
 * sends: never for an over-cap send.
 */
async function trySendWithPermission({ supabase, provider, accountId, wallet, symbol, amount, to, onBroadcast, beforeSend, log = console }) {
  const ownerPath = (reason) => {
    log.warn(`[custody] ${symbol} send on the owner key: ${reason}`);
    return null;
  };
  let relayer;
  try {
    relayer = relayerWallet(provider);
  } catch {
    return ownerPath('relayer key is malformed');
  }
  let plan;
  try {
    plan = await planPermissionSend({ supabase, provider, accountId, wallet, symbol, amount, relayer });
  } catch (err) {
    return ownerPath(`could not check the permission (${loggable(err)})`);
  }
  if (plan.route === 'owner') return ownerPath(plan.reason);
  if (plan.route === 'over_cap') {
    log.info(`[custody] ${symbol} send is over today's allowance: waiting for a passkey approval`);
    return { route: 'over_cap', available: plan.available, delegate: plan.signed.delegation.delegate };
  }
  try {
    if (beforeSend) await beforeSend();
    const sent = await sendWithPermission({ provider, relayer, signed: plan.signed, to, amount, onBroadcast });
    return { ...sent, route: 'permission' };
  } catch (err) {
    if (err instanceof PermissionNotUsed) return ownerPath(err.reason);
    throw err;
  }
}

module.exports = {
  PermissionNotUsed,
  relayerWallet,
  symbolForToken,
  signedFromRow,
  availableToday,
  planPermissionSend,
  sendWithPermission,
  trySendWithPermission,
};
