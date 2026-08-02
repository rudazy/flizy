/**
 * Parse send … to @user on github (and github:user shorthand)
 * Run: node --test test/parseSendGithub.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSendCommand } = require('../lib/router');

describe('parseSendCommand github', () => {
  it('parses preferred form: to @login on github', () => {
    const a = parseSendCommand('send 0.001 to @rudazy on github');
    assert.equal(a.amountEth, '0.001');
    assert.equal(a.toRaw, 'rudazy');
    assert.equal(a.platform, 'github');
    assert.equal(a.isPhone, false);
    assert.equal(a.isAddress, false);

    const b = parseSendCommand('send 0.01 eth to @rudazy on github');
    assert.equal(b.platform, 'github');
    assert.equal(b.toRaw, 'rudazy');
  });

  it('allows login without @', () => {
    const a = parseSendCommand('send 0.001 to rudazy on github');
    assert.equal(a.platform, 'github');
    assert.equal(a.toRaw, 'rudazy');
  });

  it('still accepts github:login shorthand', () => {
    const a = parseSendCommand('send 0.001 to github:octocat');
    assert.equal(a.platform, 'github');
    assert.equal(a.toRaw, 'octocat');
  });

  it('parses asset form on github', () => {
    const a = parseSendCommand('send 10 FLZ to @octocat on github');
    assert.equal(a.platform, 'github');
    assert.equal(a.asset, 'FLZ');
    assert.equal(a.toRaw, 'octocat');
  });

  it('still parses bare trusted name', () => {
    const a = parseSendCommand('send 0.01 to john');
    assert.equal(a.platform, null);
    assert.equal(a.toRaw, 'john');
  });

  it('does not treat github alone as platform', () => {
    const a = parseSendCommand('send 0.01 to github');
    assert.equal(a.platform, null);
    assert.equal(a.toRaw, 'github');
  });
});
