/**
 * NFT index parsers: explorer responses become typed rows, and anything
 * malformed or unsafe becomes a missing value instead of a wrong one.
 *
 * Run: node --test test/nftIndex.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let idx;
before(async () => {
  idx = await import('../web/lib/nftIndex.ts');
});

const GIWAFORGE = '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A';
const ALICE = '0x146f0Ee617e0b860A4d2fB454Ae65720C315bbA7';
const ZERO = '0x0000000000000000000000000000000000000000';
const TX = `0x${'ab'.repeat(32)}`;
const BIG_ID = '115792050666661005089728720832241754613649434876690179486688455171151146993437';

describe('validation', () => {
  it('checksums addresses and rejects junk', () => {
    assert.equal(idx.checkAddress(GIWAFORGE.toLowerCase()), GIWAFORGE);
    assert.equal(idx.checkAddress('0x123'), null);
    assert.equal(idx.checkAddress(42), null);
  });

  it('keeps 78-digit token ids exact and normalises leading zeros', () => {
    assert.equal(idx.checkTokenId(BIG_ID), BIG_ID);
    assert.equal(idx.checkTokenId('007'), '7');
    assert.equal(idx.checkTokenId(12), '12');
    assert.equal(idx.checkTokenId('-1'), null);
    assert.equal(idx.checkTokenId('1e3'), null);
    assert.equal(idx.checkTokenId('9'.repeat(79)), null);
  });
});

describe('safeImageUrl', () => {
  it('allows https and rewrites ipfs to a gateway', () => {
    assert.equal(idx.safeImageUrl('https://a.example/x.png'), 'https://a.example/x.png');
    assert.equal(idx.safeImageUrl('ipfs://bafy123/1.png'), 'https://ipfs.io/ipfs/bafy123/1.png');
    assert.equal(idx.safeImageUrl('ipfs://ipfs/bafy123'), 'https://ipfs.io/ipfs/bafy123');
  });

  it('drops http, javascript, credentials and non-image data urls', () => {
    assert.equal(idx.safeImageUrl('http://a.example/x.png'), null);
    assert.equal(idx.safeImageUrl('javascript:alert(1)'), null);
    assert.equal(idx.safeImageUrl('https://user:pw@a.example/x.png'), null);
    assert.equal(idx.safeImageUrl('data:text/html;base64,PGgxPg=='), null);
    assert.equal(idx.safeImageUrl('ipfs://../../etc'), null);
    assert.equal(idx.safeImageUrl(null), null);
  });

  it('allows small inline images only', () => {
    assert.ok(idx.safeImageUrl('data:image/png;base64,AAAA'));
    assert.equal(idx.safeImageUrl(`data:image/png;base64,${'A'.repeat(200_001)}`), null);
  });
});

describe('parsers', () => {
  it('parses a collection and falls back to a short address for a missing name', () => {
    const c = idx.parseCollection({
      address_hash: GIWAFORGE,
      name: 'Giwaforge',
      symbol: 'FORGE',
      type: 'ERC-721',
      holders_count: '35',
      total_supply: '38',
      icon_url: null,
    });
    assert.deepEqual(c, {
      address: GIWAFORGE,
      name: 'Giwaforge',
      symbol: 'FORGE',
      standard: 'ERC-721',
      holders: 35,
      supply: '38',
      icon: null,
    });
    assert.equal(idx.parseCollection({ address_hash: GIWAFORGE, type: 'ERC-721' }).name, '0xa613...CB2A');
    assert.equal(idx.parseCollection({ address_hash: GIWAFORGE, type: 'ERC-20' }), null);
  });

  it('parses an instance with metadata, traits and a sanitised image', () => {
    const item = idx.parseInstance(
      {
        id: BIG_ID,
        image_url: 'https://img.example/1.png',
        owner: { hash: ALICE },
        metadata: {
          name: 'nk2egmjp.up.id',
          description: 'An identity',
          attributes: [{ trait_type: 'length', value: 8 }, { trait_type: '', value: 'x' }, 'junk'],
          url: 'https://upbit.com/',
        },
      },
      GIWAFORGE
    );
    assert.equal(item.tokenId, BIG_ID);
    assert.equal(item.owner, ALICE);
    assert.equal(item.name, 'nk2egmjp.up.id');
    assert.deepEqual(item.traits, [{ trait: 'length', value: '8' }]);
    assert.equal(item.externalUrl, 'https://upbit.com/');
  });

  it('a token without metadata still parses, with nothing invented', () => {
    const item = idx.parseInstance({ id: '23', image_url: null, metadata: null, owner: null }, GIWAFORGE);
    assert.deepEqual(item, {
      collection: GIWAFORGE,
      tokenId: '23',
      name: null,
      description: null,
      image: null,
      owner: null,
      traits: [],
      externalUrl: null,
    });
  });

  it('parses wallet NFTs with their collection', () => {
    const rows = idx.parseWalletNfts(
      {
        items: [
          { id: '23', value: '1', token: { address_hash: GIWAFORGE, name: 'Giwaforge', type: 'ERC-721' } },
          { id: '1', token: { address_hash: 'bad', type: 'ERC-721' } },
        ],
      },
      ALICE
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner, ALICE);
    assert.equal(rows[0].collectionName, 'Giwaforge');
    assert.equal(rows[0].standard, 'ERC-721');
  });

  it('labels mints, transfers and burns', () => {
    const row = (from, to) => ({
      total: { token_id: '5' },
      from: { hash: from },
      to: { hash: to },
      transaction_hash: TX,
      timestamp: '2026-09-27T17:33:27.000000Z',
    });
    const rows = idx.parseTransfers({ items: [row(ZERO, ALICE), row(ALICE, GIWAFORGE), row(ALICE, ZERO), { junk: 1 }] });
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['mint', 'transfer', 'burn']
    );
  });

  it('parses holders and skips zero balances', () => {
    const rows = idx.parseHolders({
      items: [
        { address: { hash: ALICE }, value: '2' },
        { address: { hash: GIWAFORGE }, value: '0' },
      ],
    });
    assert.deepEqual(rows, [{ address: ALICE, count: 2 }]);
  });

  it('parses raw logs and skips incomplete ones', () => {
    const rows = idx.parseLogs({
      items: [
        { topics: [TX, null], data: '0x00', block_number: 1, index: 2, transaction_hash: TX, block_timestamp: '2026-10-02T08:12:04Z' },
        { topics: [TX], data: 'zz', block_number: 1, index: 2, transaction_hash: TX },
      ],
    });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].topics, [TX]);
  });
});

describe('cursors', () => {
  it('keeps a 78-digit cursor exact by reading the raw text', () => {
    const raw = `{"items":[],"next_page_params":{"unique_token":${BIG_ID},"items_count":50,"x":null}}`;
    const cursor = idx.nextCursor(raw);
    assert.equal(new URLSearchParams(cursor).get('unique_token'), BIG_ID);
    assert.equal(new URLSearchParams(cursor).get('items_count'), '50');
    assert.equal(new URLSearchParams(cursor).has('x'), false);
    assert.equal(idx.nextCursor('{"next_page_params":null}'), null);
  });

  it('accepts only cursor-shaped input from a browser', () => {
    assert.equal(idx.checkCursor('index=21&block_number=34725561'), 'index=21&block_number=34725561');
    assert.equal(idx.checkCursor('bad-key=1'), null);
    assert.equal(idx.checkCursor('a'.repeat(1001)), null);
    assert.equal(idx.checkCursor(''), null);
  });
});

describe('NftIndex fetch', () => {
  it('refuses a non-https explorer', () => {
    assert.throws(() => new idx.NftIndex('http://sepolia-explorer.giwa.io'));
    assert.throws(() => new idx.NftIndex('https://x.example/path'));
  });

  it('builds paths from validated input and caches the answer', async () => {
    const seen = [];
    const fetcher = async (url) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ address_hash: GIWAFORGE, name: 'Giwaforge', type: 'ERC-721', holders_count: '35' }),
      };
    };
    const index = new idx.NftIndex('https://cache-test.example', fetcher);
    const first = await index.collection(GIWAFORGE);
    const second = await index.collection(GIWAFORGE);
    assert.equal(first.holders, 35);
    assert.deepEqual(second, first);
    assert.deepEqual(seen, [`https://cache-test.example/api/v2/tokens/${GIWAFORGE}`]);
  });

  it('treats 404 as unknown and other failures as errors', async () => {
    const make = (status) =>
      new idx.NftIndex(`https://s${status}.example`, async () => ({ ok: false, status, text: async () => '' }));
    assert.equal(await make(404).collection(GIWAFORGE), null);
    await assert.rejects(make(500).collection(GIWAFORGE), /unavailable/);
  });
});
