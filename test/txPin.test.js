/**
 * The transaction PIN switch: off as the app ships on testnet, the same on the
 * site and in chat, and only transactions follow it.
 *
 * With it off, a site money route passes on the session alone, even for an
 * account that never set a PIN. What stays: account changes take the password
 * (test/routeGuards.test.js), and the chat unlock takes the PIN
 * (test/chatHardening.test.js), which is how a hijacked chat is still stopped.
 *
 * Run: node --test test/txPin.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let site;
let stepUp;
before(async () => {
  site = await import('../web/lib/txPin.ts');
  stepUp = await import('../web/lib/stepUp.ts');
});

describe('the switch', () => {
  it('ships off, on the site and in chat alike', () => {
    assert.equal(site.txPin.required, false);
    assert.equal(require('../lib/tiers').txPin.required, false);
    assert.match(read('web/lib/txPin.ts'), /export const txPin = \{ required: false \};/);
    assert.match(read('lib/tiers.js'), /const txPin = \{ required: false \};/);
  });

  it('is changed by nothing in the app, only by the test suite', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (['node_modules', '.next', 'generated'].includes(e.name)) continue;
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.(js|ts|tsx)$/.test(e.name) && /txPin\.required\s*=[^=]/.test(read(rel))) offenders.push(rel);
      }
    };
    for (const dir of ['lib', 'web/lib', 'web/app', 'web/components']) walk(dir);
    assert.deepEqual(offenders, []);
  });
});

describe('with it off', () => {
  it('a site money route passes on the session alone, even with no PIN set', async () => {
    const fake = createFakeSupabase({ accounts: [{ id: 'me', unlock_pin_hash: null }], login_attempts: [] });
    assert.deepEqual(await stepUp.requireStepUp(fake.client, 'me', '', 'pay'), { ok: true });
    assert.deepEqual(await stepUp.requireApproval(fake.client, 'me', '', 'pay', { tier: 1, reason: 'new_recipient' }), { ok: true });
  });

  it('the chat unlock still checks the PIN, which is not a transaction', () => {
    const page = read('web/app/api/approvals/[token]/route.ts');
    assert.match(page, /const check = await checkPin\(supabase, row\.account_id, pin\);/);
    assert.doesNotMatch(page, /txPin/);
  });

  it('the pay, mint, NFT and limit screens hide the PIN field', () => {
    assert.match(read('web/components/PayLanding.tsx'), /const needsPin =\s*txPin\.required &&/);
    assert.match(read('web/components/MintActionSheet.tsx'), /\{txPin\.required \? <PinField value=\{pin\} onChange=\{setPin\} \/> : null\}/);
    // A wallet-mode trade is signed in the visitor's own wallet, which never takes a Flizy PIN.
    assert.match(read('web/components/NftTradeSheet.tsx'), /\{txPin\.required && !walletMode \? <PinField value=\{pin\} onChange=\{setPin\} \/> : null\}/);
    assert.match(read('web/app/dashboard/swap/page.tsx'), /const pinNeeded = txPin\.required && mode === 'limit';/);
  });
});
