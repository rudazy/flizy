/**
 * My NFTs for a visitor with a connected wallet and no Flizy account.
 *
 * What is pinned: likes are kept per wallet in this browser only, checked on
 * every read, capped, and never sent to the server until a signed-in account
 * chooses to save them; My NFTs opens in wallet mode and reads the wallet's
 * holdings and offers by address, behind the anonymous read cap; a signed-in
 * account still reads only its own wallet; a guest cannot decline (an account
 * action) but can accept; the invitation to an account never blocks anything
 * and claims nothing an account does not do.
 *
 * Run: node --test test/guestNftProfile.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let G;
before(async () => {
  G = await import('../web/lib/guestLikes.ts');
});

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/** A localStorage stand-in. */
function memory(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const WALLET = '0x' + 'ab'.repeat(20);
const OTHER = '0x' + 'cd'.repeat(20);
const COL = '0x' + '12'.repeat(20);
const nft = (tokenId, extra = {}) => ({ collection: COL, collectionName: 'Cats', tokenId, name: `Cat #${tokenId}`, image: 'https://x/1.png', ...extra });

describe('guest likes in this browser', () => {
  it('hearts and un-hearts per wallet, newest first', () => {
    const s = memory();
    G.setGuestLike(WALLET, nft('1'), true, s);
    G.setGuestLike(WALLET, nft('2'), true, s);
    assert.deepEqual(G.readGuestLikes(WALLET, s).map((l) => l.tokenId), ['2', '1']);
    G.setGuestLike(WALLET, nft('1'), false, s);
    assert.deepEqual(G.readGuestLikes(WALLET, s).map((l) => l.tokenId), ['2']);
    assert.deepEqual(G.readGuestLikes(OTHER, s), [], 'another wallet has its own list');
  });

  it('drops bad entries from storage instead of trusting them', () => {
    const s = memory({
      [`flizy:guest-likes:${WALLET}`]: JSON.stringify([
        { collection: 'not-an-address', tokenId: '1' },
        { collection: COL, tokenId: '1; drop', name: 'x' },
        { collection: COL, tokenId: '3', name: 'ok', image: 'javascript:alert(1)' },
      ]),
    });
    const list = G.readGuestLikes(WALLET, s);
    assert.equal(list.length, 1);
    assert.equal(list[0].image, null, 'only https or same-site images');
    assert.deepEqual(G.readGuestLikes(WALLET, memory({ [`flizy:guest-likes:${WALLET}`]: '{oops' })), []);
  });

  it('caps the list', () => {
    const s = memory();
    for (let i = 0; i < G.MAX_GUEST_LIKES + 5; i += 1) G.setGuestLike(WALLET, nft(String(i)), true, s);
    assert.equal(G.readGuestLikes(WALLET, s).length, G.MAX_GUEST_LIKES);
  });

  it('gathers every wallet for saving to an account, once each, then forgets them', () => {
    const s = memory({ unrelated: 'keep' });
    G.setGuestLike(WALLET, nft('1'), true, s);
    G.setGuestLike(OTHER, nft('1'), true, s);
    G.setGuestLike(OTHER, nft('2'), true, s);
    assert.equal(G.allGuestLikes(s).length, 2);
    G.clearGuestLikes(s);
    assert.deepEqual(G.allGuestLikes(s), []);
    assert.equal(s.getItem('unrelated'), 'keep');
  });

  it('works with storage off', () => {
    assert.deepEqual(G.readGuestLikes(WALLET, null), []);
    assert.deepEqual(G.setGuestLike(WALLET, nft('1'), true, null), []);
  });

  it('never leaves the browser on its own', () => {
    assert.doesNotMatch(read('web/lib/guestLikes.ts'), /fetch\(|^import /m);
  });
});

describe('My NFTs in wallet mode', () => {
  const profile = read('web/components/NftProfile.tsx');

  it('reads the connected wallet by address, and its likes from this browser', () => {
    assert.match(profile, /const guestAddress = useWalletMode\(\)\?\.address \?\? null;/);
    assert.match(profile, /fetch\(`\/api\/nfts\/mine\$\{viewerQuery\}`\)/);
    assert.match(profile, /fetch\(`\/api\/nfts\/offers\$\{viewerQuery\}`\)/);
    assert.match(profile, /readGuestLikes\(guestAddress\)/);
  });

  it('lets a guest accept but not decline, which is saved to an account', () => {
    assert.match(profile, /canDecline=\{!guestAddress\}/);
    assert.match(profile, /\{canDecline \? \(/);
  });

  it('offers a signed-in account to save the likes it gave as a guest, then forgets them here', () => {
    assert.match(profile, /if \(!guestAddress && dash\) setCarried\(allGuestLikes\(\)\);/);
    assert.match(profile, /fetch\('\/api\/nfts\/favorites', \{/);
    assert.match(profile, /clearGuestLikes\(\);/);
  });

  it('invites to an account without gating anything', () => {
    assert.match(profile, /\{guestAddress \? <GuestCard \/> : null\}/);
    assert.match(profile, /Create a free account/);
  });

  it('hearts on a collection page go to this browser in wallet mode', () => {
    const col = read('web/components/NftCollection.tsx');
    assert.match(col, /if \(guestAddress\) \{\s*const mine = setGuestLike\(/);
    assert.match(col, /Saved to My NFTs on this device\./);
  });

  it('is reachable from the wallet bar', () => {
    assert.match(read('web/components/WalletModeBits.tsx'), /href="\/dashboard\/explore\/nfts\/me"/);
  });

  it('does not promise what an account does not do: sale notices follow the Flizy wallet only', () => {
    const sheet = read('web/components/NftTradeSheet.tsx');
    assert.match(sheet, /A free Flizy account adds payments by @username in WhatsApp and Telegram\./);
    assert.doesNotMatch(sheet, /moment it sells/);
  });
});

describe('the APIs a guest reads', () => {
  for (const rel of ['web/app/api/nfts/mine/route.ts', 'web/app/api/nfts/offers/route.ts']) {
    const route = read(rel);
    it(`${rel}: a signed-in account reads its own wallet; a guest names one, under the read cap`, () => {
      assert.match(route, /const guest = accountId \? null : guestViewer\(req\);/);
      assert.match(route, /if \(!accountId && !guest\) return NextResponse\.json\(\{ error: 'Not logged in' \}, \{ status: 401 \}\)/);
      assert.match(route, /const limited = await anonymousReadLimit\(accountId\);/);
    });
  }

  it('takes only a well-formed address as the viewer', () => {
    assert.match(read('web/lib/nftApi.ts'), /return \/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(raw\) \? ethers\.getAddress\(raw\) : null;/);
  });

  it('names an offer maker by @username only with their Scan consent, since any wallet can be read', () => {
    const book = read('web/lib/offerBook.ts');
    assert.match(book, /\.select\('username, scan_show_username'\)/);
    assert.match(book, /if \(data\?\.username && data\.scan_show_username === true\) out\.set\(maker, `@\$\{data\.username\}`\);/);
  });

  it('hides nothing as declined for a guest, who has no account to have declined with', () => {
    assert.match(read('web/lib/offerBook.ts'), /const declined = accountId \? await declinedOfferIds\(accountId, ctx\.market\.address\) : new Set<string>\(\);/);
  });

  it('says so in the privacy policy', () => {
    assert.match(read('web/app/privacy/page.tsx'), /NFTs you heart without an\s+account are kept in this browser only, never sent to us;/);
  });
});
