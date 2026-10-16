/**
 * The Ammora SDK, loaded once. It is ESM-only and the bot is CommonJS, so it
 * comes in through a dynamic import (about 1.5 s the first time). Nothing
 * loads it while AMMORA_ENABLED is off.
 */

let sdkPromise = null;

/** @returns {Promise<typeof import('@ammora-protocol/sdk')>} */
function loadAmmoraSdk() {
  if (!sdkPromise) {
    sdkPromise = import('@ammora-protocol/sdk').catch((err) => {
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
}

/** Tests replace the SDK with a scripted one. */
function setAmmoraSdkForTests(sdk) {
  sdkPromise = sdk ? Promise.resolve(sdk) : null;
}

module.exports = { loadAmmoraSdk, setAmmoraSdkForTests };
