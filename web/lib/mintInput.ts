/**
 * Flizy Mint input checks, pure: what a person types for a mint, a schedule,
 * a new collection or an allowlist, turned into values safe to hand to the
 * chain or the database, or refused with a message they can act on.
 *
 * No framework or database imports, so test/mintInput.test.js can load it
 * directly. web/lib/mintRequest.ts turns an InputError into a 400.
 */

import { ethers } from 'ethers';
import { normalizeUsername } from './username.ts';

/** A refusal written for the person. Always a 400. */
export class InputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** Most allowlist lines one request may add. */
export const ALLOWLIST_BATCH_MAX = 2000;
/** Must match the nft_drop_allowlist_before_insert cap. */
export const ALLOWLIST_MAX = 10_000;

const MAX_PRICE_WEI = ethers.parseEther('1000000');

/** "0.05" style ETH amount typed by a person, as wei. "0" is allowed: a free mint. */
export function ethToWei(raw: unknown, what: string): string {
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  if (!/^[0-9]{1,7}(\.[0-9]{1,18})?$/.test(text)) throw new InputError(`Enter a valid ${what} in ETH.`);
  const wei = ethers.parseEther(text);
  if (wei < 0n || wei > MAX_PRICE_WEI) throw new InputError(`Enter a valid ${what} in ETH.`);
  return wei.toString();
}

/** Whole number in [min, max], or an InputError naming `what`. */
export function intField(raw: unknown, what: string, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`${what} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** Unix seconds in the given range, or an InputError. 0 or empty means "not set". */
export function timeField(raw: unknown, what: string): number {
  if (raw == null || raw === '' || raw === 0) return 0;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 4_102_444_800) throw new InputError(`${what} is not a valid time.`);
  return n;
}

/**
 * Printable ASCII without the characters that break on-chain JSON, as
 * FlizyCollection checks. Used for names and symbols that go on chain.
 */
export function chainText(raw: unknown, what: string, maxLen: number): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.length > maxLen || !/^[\x20-\x7e]+$/.test(text) || /["\\]/.test(text)) {
    throw new InputError(`${what} must be 1 to ${maxLen} plain characters, without quotes or backslashes.`);
  }
  return text;
}

/** Optional free text for the page (description), trimmed and capped. */
export function pageText(raw: unknown, maxLen: number): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw new InputError('Invalid text.');
  const text = raw.trim();
  if (text.length > maxLen) throw new InputError(`Keep it under ${maxLen} characters.`);
  return text || null;
}

/** https:// or ipfs:// artwork URL, the shape the database and FlizyCollection accept. */
export function artworkUrl(raw: unknown, what: string, required: boolean): string | null {
  if (raw == null || raw === '') {
    if (required) throw new InputError(`Add ${what}: an https:// or ipfs:// link.`);
    return null;
  }
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!/^(https|ipfs):\/\/[\x21-\x7e]{1,500}$/.test(text) || /["\\]/.test(text) || text.length > 512) {
    throw new InputError(`${what} must be an https:// or ipfs:// link.`);
  }
  if (text.startsWith('https://')) {
    try {
      new URL(text);
    } catch {
      throw new InputError(`${what} must be an https:// or ipfs:// link.`);
    }
  }
  return text;
}


export type ParsedAllowlist = {
  usernames: Array<{ username: string; allowance: number }>;
  addresses: Array<{ address: string; allowance: number; source: 'address' | 'csv' }>;
  errors: string[];
};

function allowanceOf(raw: string | undefined, fallback: number): number | null {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= ALLOWLIST_MAX ? n : null;
}

/**
 * Parse what a creator pasted or uploaded. One entry per line, or several
 * separated by commas, semicolons or spaces when there is no allowance:
 *   @john            Flizy username, default allowance
 *   @john 2          with an allowance (also "@john,2" or "@john:2")
 *   0xabc...         wallet address
 *   0xabc..., 3      CSV row: address, allowance
 * A header row ("address,allowance") is ignored. Duplicates keep the last
 * allowance given. Bad lines are reported, not guessed at.
 */
export function parseAllowlistInput(text: string, defaultAllowance: number, csv = false): ParsedAllowlist {
  const out: ParsedAllowlist = { usernames: [], addresses: [], errors: [] };
  const names = new Map<string, number>();
  const wallets = new Map<string, number>();
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^address\s*[,;]/i.test(line)) continue;
    // "name 2", "name,2", "name:2", "0x..,2" => one entry with an allowance.
    const pair = line.match(/^(@?[A-Za-z0-9_.]+|0x[0-9a-fA-F]{40})\s*[,;:\s]\s*([0-9]+)$/);
    const parts = pair ? [[pair[1], pair[2]]] : line.split(/[,;\s]+/).filter(Boolean).map((p) => [p, undefined]);
    for (const [token, allowanceRaw] of parts as Array<[string, string | undefined]>) {
      const allowance = allowanceOf(allowanceRaw, defaultAllowance);
      if (allowance == null) {
        out.errors.push(`${token}: allowance must be a whole number from 1 to ${ALLOWLIST_MAX}`);
        continue;
      }
      // Anything starting 0x is meant as an address: a typo must say so, not
      // turn into a username lookup.
      if (/^0x/i.test(token)) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !ethers.isAddress(token)) {
          out.errors.push(`${token}: not a valid address`);
          continue;
        }
        wallets.set(ethers.getAddress(token), allowance);
      } else if (/^@?[A-Za-z0-9_.]{1,32}$/.test(token)) {
        const name = normalizeUsername(token);
        if (!name) {
          out.errors.push(`${token}: not a username`);
          continue;
        }
        names.set(name, allowance);
      } else {
        out.errors.push(`${token.slice(0, 48)}: not a username or wallet address`);
      }
    }
  }
  out.usernames = [...names].map(([username, allowance]) => ({ username, allowance }));
  out.addresses = [...wallets].map(([address, allowance]) => ({ address, allowance, source: csv ? 'csv' : 'address' }));
  return out;
}

// ------------------------------------------------------- allowlist privacy

export type AllowlistEntryView = {
  /** What the page sends back to remove the entry: "@name" or the wallet address. */
  key: string;
  label: string;
  allowance: number;
  source: 'username' | 'address' | 'csv';
};

/**
 * The allowlist as the creator sees it. An entry added by Flizy username is
 * shown, exported and removed by that username only: the wallet behind it
 * stays on the server, so adding @someone to a drop never reveals their
 * address. Entries the creator added by address show the address they typed.
 */
export function allowlistEntriesForCreator(
  rows: Array<{ address: string; allowance: number; source: 'username' | 'address' | 'csv'; username: string | null }>
): AllowlistEntryView[] {
  return rows.map((r) =>
    r.source === 'username' && r.username
      ? { key: `@${r.username}`, label: `@${r.username}`, allowance: r.allowance, source: r.source }
      : { key: r.address, label: r.address, allowance: r.allowance, source: r.source }
  );
}

/** Keys to remove, split into wallet addresses and usernames; refused if any key is neither. */
export function parseRemoveKeys(raw: unknown): { addresses: string[]; usernames: string[] } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ALLOWLIST_BATCH_MAX) {
    throw new InputError('Choose the entries to remove.');
  }
  const addresses: string[] = [];
  const usernames: string[] = [];
  for (const k of raw) {
    const text = typeof k === 'string' ? k.trim() : '';
    if (/^0x[0-9a-fA-F]{40}$/.test(text) && ethers.isAddress(text)) addresses.push(ethers.getAddress(text));
    else if (/^@[A-Za-z0-9_.]{1,32}$/.test(text)) usernames.push(normalizeUsername(text));
    else throw new InputError('One of those is not on this allowlist.');
  }
  return { addresses, usernames };
}
