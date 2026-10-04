/**
 * Flizy Mint input checks: ETH amounts, whole numbers, times, on-chain text,
 * artwork links, and the allowlist a creator pastes or uploads.
 *
 * Run: node --test test/mintInput.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let m;
before(async () => {
  m = await import('../web/lib/mintInput.ts');
});

describe('field checks', () => {
  it('ethToWei accepts 0 (free) and decimals, refuses junk', () => {
    assert.equal(m.ethToWei('0', 'price'), '0');
    assert.equal(m.ethToWei('0.05', 'price'), '50000000000000000');
    assert.equal(m.ethToWei(1, 'price'), '1000000000000000000');
    for (const bad of ['', '-1', '1e3', '0.1.2', 'abc', '10000000', '0.0000000000000000001']) {
      assert.throws(() => m.ethToWei(bad, 'price'), m.InputError, bad);
    }
  });

  it('intField and timeField', () => {
    assert.equal(m.intField('5', 'Limit', 1, 10), 5);
    assert.throws(() => m.intField(0, 'Limit', 1, 10), /from 1 to 10/);
    assert.throws(() => m.intField(1.5, 'Limit', 1, 10));
    assert.equal(m.timeField('', 'Start'), 0);
    assert.equal(m.timeField(1_800_000_000, 'Start'), 1_800_000_000);
    assert.throws(() => m.timeField(-5, 'Start'));
    assert.throws(() => m.timeField(9_999_999_999, 'Start'));
  });

  it('chainText refuses what would break on-chain JSON', () => {
    assert.equal(m.chainText('  Franky the Frog ', 'Name', 64), 'Franky the Frog');
    for (const bad of ['', 'a"b', 'a\\b', 'caf\u00e9', 'x'.repeat(65), 'line\nbreak']) {
      assert.throws(() => m.chainText(bad, 'Name', 64), m.InputError, JSON.stringify(bad));
    }
  });

  it('artworkUrl allows https and ipfs only', () => {
    assert.equal(m.artworkUrl('https://flizy.app/a.png', 'Art', true), 'https://flizy.app/a.png');
    assert.equal(m.artworkUrl('ipfs://bafy123', 'Art', true), 'ipfs://bafy123');
    assert.equal(m.artworkUrl('', 'Banner', false), null);
    assert.throws(() => m.artworkUrl('', 'Art', true), /https:\/\/ or ipfs:\/\//);
    for (const bad of ['http://x.png', 'javascript:alert(1)', 'https://a b.png', 'https://a"b', 'data:image/png;base64,xx']) {
      assert.throws(() => m.artworkUrl(bad, 'Art', true), m.InputError, bad);
    }
  });

  it('pageText trims and caps', () => {
    assert.equal(m.pageText('  hi  ', 10), 'hi');
    assert.equal(m.pageText('', 10), null);
    assert.throws(() => m.pageText('x'.repeat(11), 10));
  });
});

describe('parseAllowlistInput', () => {
  const W1 = '0x146f0Ee617e0b860A4d2fB454Ae65720C315bbA7';
  const W2 = '0x20554499dE2DD0C32cEF1822dfD47f41BDA75989';

  it('usernames with and without an allowance', () => {
    const r = m.parseAllowlistInput('@John\n@alice 2\nbob,3\ncarol:4', 1);
    assert.deepEqual(r.usernames, [
      { username: 'john', allowance: 1 },
      { username: 'alice', allowance: 2 },
      { username: 'bob', allowance: 3 },
      { username: 'carol', allowance: 4 },
    ]);
    assert.deepEqual(r.errors, []);
  });

  it('several on one line when no allowance is given', () => {
    const r = m.parseAllowlistInput(`@a, @b ${W1.toLowerCase()}`, 2);
    assert.deepEqual(r.usernames.map((u) => u.username), ['a', 'b']);
    assert.deepEqual(r.addresses, [{ address: W1, allowance: 2, source: 'address' }]);
  });

  it('CSV rows with a header, checksummed, last allowance wins', () => {
    const r = m.parseAllowlistInput(`address,allowance\n${W1},2\n${W2}, 5\n${W1},3`, 1, true);
    assert.deepEqual(r.addresses, [
      { address: W1, allowance: 3, source: 'csv' },
      { address: W2, allowance: 5, source: 'csv' },
    ]);
  });

  it('bad lines are reported, not guessed', () => {
    const r = m.parseAllowlistInput(`${W1},0\n@ok\n<script>\n0x1234`, 1);
    assert.deepEqual(r.usernames, [{ username: 'ok', allowance: 1 }]);
    assert.equal(r.addresses.length, 0);
    assert.equal(r.errors.length, 3);
    assert.ok(r.errors.some((e) => /allowance must be/.test(e)));
  });

  it('an invalid checksum is refused', () => {
    const mixed = '0x146F0ee617e0b860A4d2fB454Ae65720C315bbA7';
    const r = m.parseAllowlistInput(mixed, 1);
    assert.equal(r.addresses.length, 0);
    assert.match(r.errors[0], /not a valid address/);
  });
});

describe('allowlist privacy', () => {
  const W = '0x146f0Ee617e0b860A4d2fB454Ae65720C315bbA7';
  const H = '0x20554499dE2DD0C32cEF1822dfD47f41BDA75989';

  it('an entry added by username never shows its wallet', () => {
    const view = m.allowlistEntriesForCreator([
      { address: H, allowance: 2, source: 'username', username: 'alice' },
      { address: W, allowance: 1, source: 'address', username: null },
    ]);
    assert.deepEqual(view, [
      { key: '@alice', label: '@alice', allowance: 2, source: 'username' },
      { key: W, label: W, allowance: 1, source: 'address' },
    ]);
    assert.ok(!JSON.stringify(view).includes(H), 'the hidden wallet is not anywhere in the response');
  });

  it('removal keys split into addresses and usernames, anything else refused', () => {
    assert.deepEqual(m.parseRemoveKeys([W.toLowerCase(), '@Alice']), { addresses: [W], usernames: ['alice'] });
    assert.throws(() => m.parseRemoveKeys([]), m.InputError);
    assert.throws(() => m.parseRemoveKeys(['alice']), /not on this allowlist/);
    assert.throws(() => m.parseRemoveKeys(['0x1234']), /not on this allowlist/);
  });
});
