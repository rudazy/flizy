/**
 * Does every pinned Ammora contract still have the code Flizy pinned?
 *
 * deployments/ammora-giwa-sepolia.json is self-attested (scripts/ammora-pin.js).
 * Before the venue is used, each pinned address is read and its runtime code
 * hashed; any difference, a wrong chain, or a failed read turns the Ammora
 * venue off. Nothing else is affected: Flizy's own swaps, sends and the bot
 * keep running.
 *
 * Mirror: web/lib/ammora/attest.ts. test/ammoraVenueDrift.test.js.
 */

const { ethers } = require('ethers');
const { VENUE } = require('./venue');

/** How long a passing check is trusted before it is read again. */
const ATTEST_TTL_MS = 60 * 60_000;

let state = { ok: false, checkedAt: 0, mismatches: [], reason: 'not checked' };

/**
 * @param {import('ethers').Provider} provider
 * @param {object} [config]
 * @returns {Promise<{ ok: boolean, mismatches: Array<{ role: string, address: string }>, reason: string|null }>}
 */
async function checkPinnedCode(provider, config = VENUE) {
  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== Number(config.chainId)) {
      return { ok: false, mismatches: [], reason: `wrong chain ${network.chainId}` };
    }
    const mismatches = [];
    for (const [role, c] of Object.entries(config.contracts)) {
      const code = await provider.getCode(c.address);
      if (!code || code === '0x' || ethers.keccak256(code) !== c.codeHash) {
        mismatches.push({ role, address: c.address });
      }
    }
    return { ok: mismatches.length === 0, mismatches, reason: mismatches.length ? 'code changed' : null };
  } catch (err) {
    return { ok: false, mismatches: [], reason: `could not read: ${String(err && err.message ? err.message : err).slice(0, 120)}` };
  }
}

/**
 * The cached verdict, refreshed when older than the TTL. Never throws.
 * @param {import('ethers').Provider} provider
 */
async function ensureAttested(provider, { now = Date.now(), ttlMs = ATTEST_TTL_MS, config = VENUE } = {}) {
  if (state.ok && now - state.checkedAt < ttlMs) return state;
  const res = await checkPinnedCode(provider, config);
  state = { ...res, checkedAt: now };
  if (!res.ok) {
    console.error(`[ammora] venue off: ${res.reason}${res.mismatches.length ? ` (${res.mismatches.map((m) => m.role).join(', ')})` : ''}`);
  }
  return state;
}

/**
 * The last verdict, without a read: true only while a passing check is within
 * the TTL. For synchronous gates (the router allowlist); the async paths call
 * ensureAttested first, so this is fresh whenever a swap is being planned.
 */
function attestedNow({ now = Date.now(), ttlMs = ATTEST_TTL_MS } = {}) {
  return state.ok && now - state.checkedAt < ttlMs;
}

/** Tests start from a clean verdict. */
function resetAttestation() {
  state = { ok: false, checkedAt: 0, mismatches: [], reason: 'not checked' };
}

module.exports = { checkPinnedCode, ensureAttested, attestedNow, resetAttestation };
