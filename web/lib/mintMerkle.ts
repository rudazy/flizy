/**
 * Allowlist Merkle tree for FlizyDrop.
 *
 * Leaf: keccak256(bytes.concat(keccak256(abi.encode(collection, wallet, allowance)))),
 * exactly as FlizyDrop.mintAllowlist builds it. Pairs are hashed in sorted
 * order (OpenZeppelin MerkleProof), so a proof carries no left/right flags.
 * Leaves are sorted and de-duplicated before the tree is built, so the same
 * list always gives the same root whatever order it was entered in.
 *
 * Pure. contracts/test/FlizyDrop.t.sol checks the same fixed vector as
 * test/mintMerkle.test.js, so the two sides cannot drift.
 */

import { AbiCoder, concat, getAddress, keccak256 } from 'ethers';

export type AllowlistEntry = { wallet: string; allowance: number };

const coder = AbiCoder.defaultAbiCoder();

export function leafHash(collection: string, wallet: string, allowance: number | bigint): string {
  const inner = keccak256(
    coder.encode(['address', 'address', 'uint256'], [getAddress(collection), getAddress(wallet), BigInt(allowance)])
  );
  return keccak256(inner);
}

function hashPair(a: string, b: string): string {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/** Every layer, leaves first. An odd node is carried up unchanged. */
function layers(leaves: string[]): string[][] {
  const sorted = [...new Set(leaves.map((l) => l.toLowerCase()))].sort((x, y) =>
    BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0
  );
  const out: string[][] = [sorted];
  while (out[out.length - 1].length > 1) {
    const prev = out[out.length - 1];
    const next: string[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    out.push(next);
  }
  return out;
}

/** Root of the list, or the zero hash for an empty list (FlizyDrop then rejects every allowlist mint). */
export function allowlistRoot(collection: string, entries: AllowlistEntry[]): string {
  if (entries.length === 0) return `0x${'0'.repeat(64)}`;
  const all = layers(entries.map((e) => leafHash(collection, e.wallet, e.allowance)));
  return all[all.length - 1][0];
}

/** Proof for one entry, or null when that exact (wallet, allowance) is not in the list. */
export function allowlistProof(collection: string, entries: AllowlistEntry[], entry: AllowlistEntry): string[] | null {
  const target = leafHash(collection, entry.wallet, entry.allowance).toLowerCase();
  const all = layers(entries.map((e) => leafHash(collection, e.wallet, e.allowance)));
  let index = all[0].indexOf(target);
  if (index === -1) return null;
  const proof: string[] = [];
  for (let level = 0; level < all.length - 1; level += 1) {
    const layer = all[level];
    const sibling = index % 2 === 0 ? index + 1 : index - 1;
    if (sibling < layer.length) proof.push(layer[sibling]);
    index = Math.floor(index / 2);
  }
  return proof;
}

/** Recompute the root from a proof, as FlizyDrop._verify does. */
export function verifyProof(proof: string[], root: string, leaf: string): boolean {
  let h = leaf.toLowerCase();
  for (const p of proof) h = hashPair(h, p.toLowerCase());
  return h === root.toLowerCase();
}
