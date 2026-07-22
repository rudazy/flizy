/**
 * Financial intent model.
 * Clients (WhatsApp, web, future AI) map user language into these shapes.
 * Engines never care which client produced the intent.
 */

/** @typedef {'send' | 'balance' | 'request' | 'buy' | 'sell' | 'swap' | 'withdraw' | 'pay'} IntentKind */

/**
 * @typedef {object} Actor
 * @property {string} accountId
 * @property {string} [userId]
 * @property {string} waSenderId
 * @property {boolean} [isAdmin]
 * @property {number} [creditEth]
 * @property {boolean} [sessionUnlocked]
 * @property {boolean} [hasPin]
 */

/**
 * @typedef {object} SendIntent
 * @property {'send'} kind
 * @property {Actor} actor
 * @property {string} amountEth
 * @property {string} [toAddress]
 * @property {string} [toLabel]
 * @property {string} [toRaw]
 * @property {boolean} [toIsAddress]
 * @property {string} [chainId]
 * @property {string} [asset] default native
 */

/**
 * @param {object} input
 * @returns {SendIntent}
 */
function createSendIntent(input) {
  return {
    kind: 'send',
    actor: input.actor,
    amountEth: String(input.amountEth),
    toAddress: input.toAddress || null,
    toLabel: input.toLabel || null,
    toRaw: input.toRaw || null,
    toIsAddress: Boolean(input.toIsAddress),
    chainId: input.chainId || null,
    asset: input.asset || 'native',
  };
}

module.exports = {
  createSendIntent,
};
