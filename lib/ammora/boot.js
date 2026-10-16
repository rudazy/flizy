/**
 * Ammora at bot start, behind AMMORA_ENABLED.
 *
 * Off: nothing is loaded, read or scheduled. On: the pinned contracts are
 * checked (attest.js) and the SDK is loaded in the background, so the first
 * chat trade does not pay for either. A failure only leaves the Ammora venue
 * off; it never stops the bot. The pool inventory runs in one process only
 * (the WhatsApp bot), like the limit order watcher and the reconciler.
 */

const { ammoraEnabled } = require('./venue');
const { ensureAttested } = require('./attest');
const { loadAmmoraSdk } = require('./sdk');
const { startInventory } = require('./inventory');
const { publicErrorMessage } = require('../sanitize');

/**
 * @param {{ supabase: object, provider: import('ethers').Provider, inventory?: boolean }} opts
 * @returns {Promise<{ started: boolean, attested?: boolean }>}
 */
async function startAmmora({ supabase, provider, inventory = false }) {
  if (!ammoraEnabled()) return { started: false };
  let attested = false;
  try {
    attested = (await ensureAttested(provider)).ok;
    if (attested) await loadAmmoraSdk();
  } catch (err) {
    console.error('[ammora] start:', publicErrorMessage(err));
    attested = false;
  }
  console.log(`[ammora] venue ${attested ? 'on' : 'off'}`);
  // The inventory checks attestation on every pass, so a venue that was off at
  // start comes back on its own once the pinned code reads clean again.
  if (inventory) startInventory({ supabase, provider, dataApiUrl: process.env.AMMORA_DATA_API_URL });
  return { started: true, attested };
}

module.exports = { startAmmora };
