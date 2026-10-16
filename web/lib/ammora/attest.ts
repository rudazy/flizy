/**
 * Does every pinned Ammora contract still have the code Flizy pinned?
 * Mirror of lib/ammora/attest.js. On any difference, wrong chain or failed
 * read, the Ammora venue is off for this instance; nothing else changes.
 */

import { ethers } from 'ethers';
import { VENUE, type VenueConfig } from './venue.ts';

/** How long a passing check is trusted on one serverless instance. */
const ATTEST_TTL_MS = 10 * 60_000;

type Verdict = { ok: boolean; mismatches: Array<{ role: string; address: string }>; reason: string | null; checkedAt: number };

let state: Verdict = { ok: false, checkedAt: 0, mismatches: [], reason: 'not checked' };

export async function checkPinnedCode(
  provider: ethers.Provider,
  config: VenueConfig = VENUE
): Promise<Omit<Verdict, 'checkedAt'>> {
  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== Number(config.chainId)) {
      return { ok: false, mismatches: [], reason: `wrong chain ${network.chainId}` };
    }
    const mismatches: Array<{ role: string; address: string }> = [];
    for (const [role, c] of Object.entries(config.contracts)) {
      const code = await provider.getCode(c.address);
      if (!code || code === '0x' || ethers.keccak256(code) !== c.codeHash) {
        mismatches.push({ role, address: c.address });
      }
    }
    return { ok: mismatches.length === 0, mismatches, reason: mismatches.length ? 'code changed' : null };
  } catch (err) {
    return { ok: false, mismatches: [], reason: `could not read: ${String(err instanceof Error ? err.message : err).slice(0, 120)}` };
  }
}

/** The cached verdict, refreshed when older than the TTL. Never throws. */
export async function ensureAttested(
  provider: ethers.Provider,
  opts: { now?: number; ttlMs?: number; config?: VenueConfig } = {}
): Promise<Verdict> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? ATTEST_TTL_MS;
  if (state.ok && now - state.checkedAt < ttlMs) return state;
  const res = await checkPinnedCode(provider, opts.config ?? VENUE);
  state = { ...res, checkedAt: now };
  if (!res.ok) {
    console.error(`[ammora] venue off: ${res.reason}${res.mismatches.length ? ` (${res.mismatches.map((m) => m.role).join(', ')})` : ''}`);
  }
  return state;
}

export function resetAttestation(): void {
  state = { ok: false, checkedAt: 0, mismatches: [], reason: 'not checked' };
}
