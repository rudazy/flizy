const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { effectiveDailyLimitEth } = require('../lib/dailyLimits');

describe('effectiveDailyLimitEth', () => {
  it('uses account override', () => {
    assert.equal(effectiveDailyLimitEth({ daily_send_limit_eth: 0.05 }, 0), 0.05);
  });
  it('null account uses default when > 0', () => {
    assert.equal(effectiveDailyLimitEth({}, 1), 1);
  });
  it('null default means no cap', () => {
    assert.equal(effectiveDailyLimitEth({ daily_send_limit_eth: null }, 0), null);
  });
});
