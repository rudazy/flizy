/**
 * Chat sends through a secured account's signed permissions.
 *
 * Once a passkey has signed Flizy's daily permissions (web/lib/custody/ceremony.ts),
 * a plain send of ETH, FLZ or tUSD from chat goes out as the relayer redeeming
 * that permission (DelegationManager.redeemDelegations), not as Flizy's owner
 * key acting on the account. The chain enforces the daily cap either way; this
 * module only decides whether a send fits today's allowance and makes it.
 *
 * Routes, decided before anything is sent (trySendWithPermission):
 *   permission  a live permission for this asset and wallet, enough of today's
 *               allowance left, and a relayer that can send it
 *   over_cap    a live permission, but the send is bigger than what is left:
 *               what the period reports, less the owner-key payments of the
 *               last 24 hours it cannot see (./ownerKeySpend.js)
 *   unchecked   a live permission whose limit could not be read
 *   owner       no live permission, or one the send fits that the relayer
 *               cannot use (no key, another relayer, busy, no gas)
 *
 * A send over the cap is never sent on the owner key: it waits for a passkey
 * approval of that one payment (lib/custody/approvals.js), or is refused when
 * no relayer could send the approved payment. An unchecked send is refused.
 * Until ownership moves to the user, a send within the limit that the relayer
 * cannot make still goes the old way, so chat never stalls. A
 * send whose outcome is unknown is never retried on the owner path: it raises
 * the same GatorExecError the engine already treats as submitted, so the money
 * cannot move twice.
 */

const { ethers } = require('ethers');
const C = require('./delegations');
const { GatorExecError, classifyBroadcastError } = require('../gatorExecute');
const { publicErrorMessage } = require('../sanitize');
const { withRelayerLock, RelayerBusy } = require('./relayerLock');
const { ownerKeyUnitsToday, permissionDecimals } = require('./ownerKeySpend');

const ENFORCER = new ethers.Interface([
  'function getAvailableAmount(bytes32 _delegationHash, address _delegationManager, bytes _terms) view returns (uint256 availableAmount_, bool isNewPeriod_, uint256 currentPeriod_)',
]);

/** A permission this close to its expiry is left alone: the send could land after it. */
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;
const RECEIPT_TIMEOUT_MS = 90 * 1000;
/** Headroom over the gas estimate, in percent. */
const GAS_HEADROOM = 120n;
/**
 * Bounds on the work done under the relayer lock, so a slow RPC cannot outlast
 * the lease (LEASE_SEC, 150 s, in ./relayerLock.js) and let a second send pick
 * the same nonce. ethers would otherwise wait up to 300 s per request.
 */
const SIGN_WITHIN_MS = 60 * 1000;
const BROADCAST_TIMEOUT_MS = 60 * 1000;

/** The broadcast, given up after BROADCAST_TIMEOUT_MS as a timeout: it may still have reached the node. */
async function broadcastWithin(provider, signedTx) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('relayer broadcast timed out'), { code: 'TIMEOUT' })), BROADCAST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([provider.broadcastTransaction(signedTx), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Raised before anything was broadcast: the caller may safely take the owner
 * path. `busy` means only that another relayer send held the lock, so a queued
 * payment can simply be tried again later.
 */
class PermissionNotUsed extends Error {
  constructor(reason, { busy = false } = {}) {
    super(`permission not used: ${reason}`);
    this.name = 'PermissionNotUsed';
    this.reason = reason;
    this.busy = busy;
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
 * `load` finds the stored permission: the account's daily permission by
 * default, a platform's API allowance for API payouts (lib/api/allowanceSend.js).
 * @returns {Promise<{route: 'permission'|'over_cap'|'owner', reason?: string, signed?: object, available?: bigint}>}
 */
async function planPermissionSend({ supabase, provider, accountId, wallet, symbol, amount, relayer, now = new Date(), load = loadPermission }) {
  if (!relayer) return { route: 'owner', reason: 'relayer key unset' };
  if (!C.ASSETS[symbol]) return { route: 'owner', reason: 'asset has no permission' };
  if (typeof amount !== 'bigint' || amount <= 0n) return { route: 'owner', reason: 'amount' };
  const row = await load(supabase, accountId, symbol, now);
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
 * The relayer lock (./relayerLock.js) is held from the nonce pick until the
 * node has accepted the transaction, so two relayer sends never pick the same
 * nonce; the receipt is awaited after it is released.
 *
 * Throws PermissionNotUsed when nothing reached the chain or the transaction
 * reverted (nothing moved), with `busy` set when only the lock was unavailable,
 * and GatorExecError('OUTCOME_UNKNOWN', submitted) when it may still confirm.
 */
async function sendWithPermission({ supabase, provider, relayer, signed, to, amount, onBroadcast }) {
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

  let txHash;
  try {
    txHash = await withRelayerLock({ supabase, relayer: relayer.address }, async () => {
      const started = Date.now();
      const populated = await relayer.populateTransaction({ to: C.CONTRACTS.delegationManager, data, gasLimit });
      const signedTx = await relayer.signTransaction(populated);
      const hash = ethers.keccak256(signedTx);
      // Too slow to trust the lease any more: stop before recording or sending anything.
      if (Date.now() - started > SIGN_WITHIN_MS) throw new PermissionNotUsed('the relayer took too long to sign', { busy: true });
      if (onBroadcast) {
        try {
          await onBroadcast(hash);
        } catch (err) {
          throw new PermissionNotUsed(`could not record the send before broadcasting (${loggable(err)})`);
        }
      }

      try {
        await broadcastWithin(provider, signedTx);
      } catch (err) {
        const kind = classifyBroadcastError(err);
        if (kind === 'rejected') throw new PermissionNotUsed(`the node refused the relayer transaction (${loggable(err)})`);
        if (kind === 'unknown') throw new GatorExecError('OUTCOME_UNKNOWN', 'Relayer broadcast did not answer', { submitted: true, txHash: hash });
        // 'accepted': the node already has it.
      }
      return hash;
    });
  } catch (err) {
    if (err instanceof RelayerBusy) throw new PermissionNotUsed(err.reason, { busy: true });
    throw err;
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
 * Today's daily limit for one asset, read whether or not the relayer can be
 * used: the stored permission for this wallet, checked against its own digest,
 * and what its period reports left. null when the account has no live daily
 * permission for this asset and wallet. Throws when it cannot be read.
 */
async function readDailyLimit({ supabase, provider, accountId, wallet, symbol, now = new Date() }) {
  const row = await loadPermission(supabase, accountId, symbol, now);
  if (!row) return null;
  const signed = signedFromRow(row);
  if (signed.delegation.delegator !== ethers.getAddress(wallet)) return null;
  return { signed, available: await availableToday(provider, signed) };
}

/**
 * The whole decision for one chat send or hold, decided before anything moves:
 *
 *   null                        not a secured account (no live permission for
 *                               this asset): the caller takes the owner path.
 *   { route: 'permission', ...} it fits, and the relayer sent it.
 *   null                        it fits, but the relayer could not be used (no
 *                               key, another relayer, busy, out of gas): the
 *                               owner path, which is within the limit anyway.
 *   { route: 'over_cap', available, delegate[, approvable: false] }
 *                               bigger than what is left today: the caller
 *                               opens a passkey approval, or refuses when
 *                               approvable is false (no relayer could send
 *                               the approved payment).
 *   { route: 'unchecked' }      a secured account whose limit could not be
 *                               read: the caller refuses, nothing is sent.
 *
 * What is left is what the period reports, less the owner-key payments of the
 * last 24 hours it cannot see (./ownerKeySpend.js). A payment over the limit
 * never goes on the owner key. Never returns null after money may have moved.
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
  if (!C.ASSETS[symbol]) return ownerPath('asset has no permission');
  if (typeof amount !== 'bigint' || amount <= 0n) return ownerPath('amount');
  const unchecked = (reason) => {
    log.warn(`[custody] ${symbol} send refused: ${reason}`);
    return { route: 'unchecked' };
  };
  let limit;
  try {
    limit = await readDailyLimit({ supabase, provider, accountId, wallet, symbol });
  } catch (err) {
    return unchecked(`could not check the permission (${loggable(err)})`);
  }
  if (!limit) return ownerPath('no permission');
  // Payments the site and checkouts made on the owner key today are not in
  // the period's own count, so they come off what it reports.
  let left;
  try {
    const spent = await ownerKeyUnitsToday(supabase, accountId, symbol, permissionDecimals(symbol));
    left = limit.available > spent ? limit.available - spent : 0n;
  } catch (err) {
    return unchecked(`could not read today's owner-key payments (${loggable(err)})`);
  }

  let relayer = null;
  let relayerProblem = null;
  try {
    relayer = relayerWallet(provider);
    if (!relayer) relayerProblem = 'relayer key unset';
  } catch {
    relayerProblem = 'relayer key is malformed';
  }
  if (relayer && limit.signed.delegation.delegate !== relayer.address) {
    relayer = null;
    relayerProblem = 'permission names another relayer';
  }
  const delegate = limit.signed.delegation.delegate;

  if (amount > left) {
    if (!relayer) {
      log.info(`[custody] ${symbol} send is over today's allowance and cannot wait for an approval (${relayerProblem}): refused`);
      return { route: 'over_cap', available: left, delegate, approvable: false };
    }
    log.info(`[custody] ${symbol} send is over today's allowance: waiting for a passkey approval`);
    return { route: 'over_cap', available: left, delegate };
  }
  if (!relayer) return ownerPath(relayerProblem);
  try {
    if (beforeSend) await beforeSend();
    const sent = await sendWithPermission({ supabase, provider, relayer, signed: limit.signed, to, amount, onBroadcast });
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
  readDailyLimit,
  sendWithPermission,
  trySendWithPermission,
};
