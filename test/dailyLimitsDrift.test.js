/**
 * Chat and site apply the same daily ETH send limit.
 *
 * web/ cannot import root lib/ on Vercel, so web/lib/dailyLimits.ts mirrors
 * lib/dailyLimits.js. What counts as sent today is one SQL function both sides
 * call; what the limit is (account value, env default, 0 versus none) is the
 * mirrored part, and this pins it.
 *
 * Run: node --test test/dailyLimitsDrift.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chat = require('../lib/dailyLimits');
let site;

before(async () => {
  site = await import('../web/lib/dailyLimits.ts');
});

describe('daily limit, chat and site', () => {
  it('resolve the effective limit identically', () => {
    const accounts = [
      null,
      {},
      { daily_send_limit_eth: null },
      { daily_send_limit_eth: '' },
      { daily_send_limit_eth: 0 },
      { daily_send_limit_eth: '0' },
      { daily_send_limit_eth: 0.05 },
      { daily_send_limit_eth: '1.5' },
      { daily_send_limit_eth: -1 },
      { daily_send_limit_eth: 'nope' },
    ];
    for (const account of accounts) {
      for (const defaultLimit of [0, -1, 0.2, 3]) {
        assert.equal(
          site.effectiveDailyLimitEth(account, defaultLimit),
          chat.effectiveDailyLimitEth(account, defaultLimit),
          `${JSON.stringify(account)} with default ${defaultLimit}`
        );
      }
    }
  });

  it('read today\'s total from the same SQL function', () => {
    const root = path.join(__dirname, '..');
    const chatSrc = fs.readFileSync(path.join(root, 'lib', 'dailyLimits.js'), 'utf8');
    const siteSrc = fs.readFileSync(path.join(root, 'web', 'lib', 'dailyLimits.ts'), 'utf8');
    for (const src of [chatSrc, siteSrc]) {
      assert.match(src, /rpc\('daily_native_sent_eth', \{\s*p_account_id: accountId/);
    }
  });

  it('read the env default under the same name', () => {
    const root = path.join(__dirname, '..');
    const config = fs.readFileSync(path.join(root, 'lib', 'config.js'), 'utf8');
    const siteSrc = fs.readFileSync(path.join(root, 'web', 'lib', 'dailyLimits.ts'), 'utf8');
    assert.match(config, /envNumber\('DEFAULT_DAILY_SEND_LIMIT_ETH', 0\)/);
    assert.match(siteSrc, /process\.env\.DEFAULT_DAILY_SEND_LIMIT_ETH/);
  });
});
