/**
 * NFTs a visitor hearts while browsing with their own wallet and no Flizy
 * account. Kept in this browser only, per wallet address, and never sent to
 * the server: wallet mode stores nothing about a guest (lib/walletMode.ts).
 * When the visitor later signs in, My NFTs offers to save these to the
 * account; until then they live and die with this browser's storage.
 *
 * Storage can be off, full or edited by hand, so every read is checked and a
 * bad entry is dropped rather than trusted. No imports, so node --test loads
 * this file directly.
 */

export type GuestLike = {
  collection: string;
  collectionName: string;
  tokenId: string;
  name: string;
  image: string | null;
  likedAt: string;
};

const PREFIX = 'flizy:guest-likes:';
/** Hearts kept per wallet; the oldest drop off past this. */
export const MAX_GUEST_LIKES = 300;

const ADDRESS = /^0x[0-9a-f]{40}$/;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function store(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function keyFor(address: string): string | null {
  const a = String(address || '').toLowerCase();
  return ADDRESS.test(a) ? `${PREFIX}${a}` : null;
}

function clean(raw: unknown): GuestLike | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const collection = String(r.collection || '').toLowerCase();
  const tokenId = String(r.tokenId ?? '');
  if (!ADDRESS.test(collection) || !/^[0-9]{1,78}$/.test(tokenId)) return null;
  const text = (v: unknown, max: number) => String(v ?? '').slice(0, max);
  const image = typeof r.image === 'string' && /^(https:\/\/|\/)/.test(r.image) ? r.image.slice(0, 1000) : null;
  return {
    collection,
    collectionName: text(r.collectionName, 80),
    tokenId,
    name: text(r.name, 120) || `#${tokenId}`,
    image,
    likedAt: text(r.likedAt, 40),
  };
}

function parse(json: string | null): GuestLike[] {
  if (!json) return [];
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list.map(clean).filter((x): x is GuestLike => x !== null).slice(0, MAX_GUEST_LIKES) : [];
  } catch {
    return [];
  }
}

/** This wallet's hearts, newest first. */
export function readGuestLikes(address: string, s: Store | null = store()): GuestLike[] {
  const key = keyFor(address);
  if (!s || !key) return [];
  try {
    return parse(s.getItem(key));
  } catch {
    return [];
  }
}

/** Hearts or un-hearts one NFT for this wallet. Returns the new list. */
export function setGuestLike(address: string, like: Omit<GuestLike, 'likedAt'>, on: boolean, s: Store | null = store()): GuestLike[] {
  const key = keyFor(address);
  const item = clean({ ...like, likedAt: new Date().toISOString() });
  if (!s || !key || !item) return readGuestLikes(address, s);
  const rest = readGuestLikes(address, s).filter((l) => !(l.collection === item.collection && l.tokenId === item.tokenId));
  const next = on ? [item, ...rest].slice(0, MAX_GUEST_LIKES) : rest;
  try {
    if (next.length) s.setItem(key, JSON.stringify(next));
    else s.removeItem(key);
  } catch {
    // Storage full or off: the heart lasts for this visit only.
  }
  return next;
}

/** Every wallet's hearts in this browser, one entry per NFT, for saving to an account. */
export function allGuestLikes(s: Store | null = store()): GuestLike[] {
  if (!s) return [];
  const seen = new Map<string, GuestLike>();
  try {
    for (let i = 0; i < s.length; i += 1) {
      const key = s.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      for (const l of parse(s.getItem(key))) seen.set(`${l.collection}:${l.tokenId}`, l);
    }
  } catch {
    return [...seen.values()];
  }
  return [...seen.values()];
}

/** Forgets every wallet's hearts in this browser, once they are saved to an account. */
export function clearGuestLikes(s: Store | null = store()): void {
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
      const key = s.key(i);
      if (key && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) s.removeItem(key);
  } catch {
    // Nothing to do: the next save offer simply appears again.
  }
}
