/**
 * The GIWA ERC20TransferAmountEnforcer deploy script stays pinned, dry-run by
 * default, deploys only that one unmodified v1.3.0 contract, and records an
 * address only when its code matches the artifact.
 *
 * Run: node --test test/delegationTransferAmountEnforcer.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'delegation-giwa-transfer-amount-enforcer.js'), 'utf8');
const code = src.slice(src.indexOf('require('));

describe('GIWA transfer-amount enforcer deploy script', () => {
  it('deploys ERC20TransferAmountEnforcer and nothing else', () => {
    assert.match(code, /const ITEM = \{ name: 'ERC20TransferAmountEnforcer', file: 'ERC20TransferAmountEnforcer\.sol'/);
    for (const other of ['AllowedCalldataEnforcer', 'LimitedCallsEnforcer', 'MultiTokenPeriodEnforcer', 'renounceOwnership', 'transferOwnership']) {
      assert.equal(code.includes(other), false, other);
    }
    assert.equal((code.match(/factory\.deploy\(\)/g) || []).length, 1, 'one deploy, no constructor arguments');
  });

  it('pins the tag commit, the chain and the compiler, and refuses main', () => {
    assert.ok(code.includes('bfbdf9795a976833ed2fa000baf42fbb83958b03'));
    assert.ok(code.includes("branch === 'main'"));
    assert.ok(code.includes('const CHAIN_ID = 91342;'));
    assert.ok(code.includes("startsWith('0.8.23')"));
  });

  it('does not broadcast unless asked, and reads the key only after that', () => {
    const gate = code.indexOf('if (!broadcast)');
    const key = code.indexOf('process.env.PRIVATE_KEY');
    assert.ok(code.includes("args.includes('--broadcast')"));
    assert.ok(gate > 0 && key > gate);
  });

  it('records an address only on an exact runtime match', () => {
    const exactCheck = code.indexOf('if (!match.exact)');
    const record = code.indexOf('out.contracts[ITEM.key] = addr');
    assert.ok(exactCheck > 0 && record > exactCheck);
    assert.ok(code.includes('runtime bytecode does not match the v1.3.0 artifact'));
    assert.ok(code.includes('Not deploying another copy.'));
  });

  it('does not print the signing key or point at a private note', () => {
    assert.equal(src.includes('console.log(process.env.PRIVATE_KEY'), false);
    for (const privateRef of ['docs/DECISIONS.md', 'tasks/', 'wbqhvmtiocoozjgwdsiq']) assert.equal(src.includes(privateRef), false, privateRef);
  });
});
