/**
 * The passkey recovery script (scripts/custody-remove-key.js).
 *
 * What is pinned: it refuses to run without the wallet address, the account id
 * and a well-formed key id; the only call it can encode is removeKey; it has no
 * ownership call in its ABI at all; and sending needs --confirm. The on-chain
 * behaviour is proven on a local GIWA copy by
 * scripts/custody-e2e/remove-key-fork-check.cjs.
 *
 * Run: node --test test/custodyRemoveKey.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { parseArgs, removeKeyCalldata } = require('../scripts/custody-remove-key');

const ADDRESS = '0x' + '11'.repeat(20);
const ID = '0b8c3f2a-1111-4222-8333-444455556666';
const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const base = ['--account', ADDRESS, '--account-id', ID, '--key-id', KEY];

describe('what the recovery script will accept', () => {
  it('reads the wallet, the account id and the key id, and is a dry run by default', () => {
    assert.deepEqual(parseArgs(base), { confirm: false, account: ethers.getAddress(ADDRESS), accountId: ID, keyId: KEY });
    assert.equal(parseArgs([...base, '--confirm']).confirm, true);
    assert.equal(parseArgs([...base, '--rpc', 'http://127.0.0.1:8546']).rpc, 'http://127.0.0.1:8546');
  });

  it('refuses without the wallet address, the account id or a real key id', () => {
    assert.throws(() => parseArgs(['--account-id', ID, '--key-id', KEY, '--confirm']), /--account must be/);
    assert.throws(() => parseArgs(['--account', ADDRESS, '--key-id', KEY]), /--account-id must be/);
    assert.throws(() => parseArgs(['--account', ADDRESS, '--account-id', ID]), /--key-id must be/);
    assert.throws(() => parseArgs(['--account', '0x1234', '--account-id', ID, '--key-id', KEY]), /--account must be/);
    assert.throws(() => parseArgs([...base.slice(0, 4), '--key-id', 'short']), /--key-id must be/);
    assert.throws(() => parseArgs([...base, '--force']), /unknown argument/);
    assert.throws(() => parseArgs(['--account', '--confirm']), /needs a value/);
  });
});

describe('what the recovery script can send', () => {
  it('encodes removeKey and nothing else', () => {
    const data = removeKeyCalldata(KEY);
    assert.equal(data.slice(0, 10), ethers.id('removeKey(string)').slice(0, 10));
    const [keyId] = new ethers.Interface(['function removeKey(string)']).decodeFunctionData('removeKey', data);
    assert.equal(keyId, KEY);
  });

  it('has no ownership call in its ABI, and sends only behind --confirm', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'custody-remove-key.js'), 'utf8');
    const abiLines = src.split('\n').filter((l) => /'function /.test(l));
    assert.ok(abiLines.length > 0);
    for (const l of abiLines) assert.doesNotMatch(l, /transferOwnership|renounceOwnership|addKey|execute/, l);
    assert.doesNotMatch(src, /encodeFunctionData\('(transferOwnership|renounceOwnership)'/);
    const send = src.indexOf('executeGatorCall({');
    const gate = src.indexOf('if (!args.confirm)');
    assert.ok(gate > 0 && send > gate, 'the confirm gate comes before the send');
  });
});
