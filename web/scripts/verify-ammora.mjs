/**
 * Build-time look at the pinned Ammora venue (web/lib/generated/ammoraVenue.json).
 *
 * Warning only, never a failed build: Ammora is an optional venue, and the
 * site enforces the same check at runtime (web/lib/ammora/attest.ts), where a
 * mismatch turns the venue off for that instance. This line exists so a
 * changed or unreachable Ammora contract shows up in the build log too.
 *
 * Skipped entirely when AMMORA_ENABLED is not "true".
 */

import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, '..', 'lib', 'generated', 'ammoraVenue.json');

async function main() {
  if (String(process.env.AMMORA_ENABLED || '').trim().toLowerCase() !== 'true') {
    console.log('[ammora] AMMORA_ENABLED is off: venue check skipped.');
    return;
  }
  const venue = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const rpc = process.env.GIWA_RPC || process.env.CHAIN_GIWA_SEPOLIA_RPC || 'https://sepolia-rpc.giwa.io';
  // Static network: no detection loop that outlives a failed read.
  const provider = new ethers.JsonRpcProvider(rpc, venue.chainId, { staticNetwork: true });
  const changed = [];
  try {
    for (const [role, c] of Object.entries(venue.contracts)) {
      const code = await provider.getCode(c.address);
      if (!code || code === '0x' || ethers.keccak256(code) !== c.codeHash) changed.push(role);
    }
  } finally {
    provider.destroy();
  }
  if (changed.length) {
    console.warn(`[ammora] WARNING: pinned code changed for ${changed.join(', ')}. The Ammora venue will stay off at runtime.`);
  } else {
    console.log(`[ammora] pinned venue verified (${Object.keys(venue.contracts).length} contracts, self-attested).`);
  }
}

main().catch((err) => {
  // The code only: an RPC error message can carry the endpoint URL and its key.
  console.warn(`[ammora] WARNING: venue check could not run (${(err && err.code) || 'error'}). The site checks again at runtime.`);
});
