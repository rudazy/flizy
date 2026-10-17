/**
 * The GIWA period-enforcer deploy script stays pinned, dry-run by default,
 * and deploys only the four unmodified v1.3.0 contracts.
 *
 * Run: node --test test/delegationPeriodEnforcers.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scriptPath = path.join(__dirname, '..', 'scripts', 'delegation-giwa-period-enforcers.js');
const src = fs.readFileSync(scriptPath, 'utf8');

describe('GIWA period enforcer deploy script', () => {
  it('names the four v1.3.0 enforcers and no others in the deploy list', () => {
    for (const name of [
      'NativeTokenPeriodTransferEnforcer',
      'ERC20PeriodTransferEnforcer',
      'ExactCalldataEnforcer',
      'ValueLteEnforcer',
    ]) {
      assert.equal(src.includes(name), true, name);
    }
    assert.equal(src.includes('MultiTokenPeriodEnforcer'), false);
    assert.equal(src.includes('renounceOwnership'), false);
  });

  it('pins the tag commit and refuses main', () => {
    assert.equal(src.includes('bfbdf9795a976833ed2fa000baf42fbb83958b03'), true);
    assert.equal(src.includes("branch === 'main'"), true);
    assert.equal(src.includes('91342'), true);
    assert.equal(src.includes('0.8.23'), true);
  });

  it('does not broadcast unless asked, and records only an exact runtime match', () => {
    const broadcast = src.indexOf("args.includes('--broadcast')");
    const key = src.indexOf('process.env.PRIVATE_KEY');
    assert.equal(broadcast > 0, true);
    assert.equal(key > broadcast, true);
    assert.equal(src.includes('if (!broadcast)'), true);
    assert.equal(src.includes('runtime bytecode does not match the v1.3.0 artifact'), true);
    assert.equal(src.includes('runtime code was not visible yet'), true);
    assert.equal(src.includes('from: \'rejected\''), true);
    assert.equal(src.includes('exactRuntimeMatch: match.exact'), true);
  });

  it('sets empty calldata terms and 32 zero bytes for value, not deploy arguments', () => {
    assert.equal(src.includes("const EMPTY_TERMS = '0x';"), true);
    assert.equal(src.includes("const ZERO_U256_TERMS = `0x${'00'.repeat(32)}`;"), true);
    assert.equal(src.includes('They are not constructor arguments.'), true);
    assert.equal(src.includes('factory.deploy()'), true);
  });

  it('does not print the signing key or point at a private note', () => {
    assert.equal(src.includes('console.log(process.env.PRIVATE_KEY'), false);
    assert.equal(src.includes('docs/DECISIONS.md'), false);
    assert.equal(src.includes('tasks/todo.md'), false);
    assert.equal(src.includes('wbqhvmtiocoozjgwdsiq'), false);
  });
});
