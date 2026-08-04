/**
 * Parse send … to @user on github|discord|x
 * Run: node --test test/parseSendGithub.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSendCommand } = require('../lib/router');

describe('parseSendCommand platforms', () => {
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

  it('parses on discord and on x', () => {
    const d = parseSendCommand('send 0.001 to 123456789012345678 on discord');
    assert.equal(d.platform, 'discord');
    assert.equal(d.toRaw, '123456789012345678');

    const x = parseSendCommand('send 0.001 to @jack on x');
    assert.equal(x.platform, 'x');
    assert.equal(x.toRaw, 'jack');

    const tw = parseSendCommand('send 0.001 to @jack on twitter');
    assert.equal(tw.platform, 'x');
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

  it('accepts discord: and x: shorthand', () => {
    assert.equal(parseSendCommand('send 0.01 to discord:99').platform, 'discord');
    assert.equal(parseSendCommand('send 0.01 to x:elonmusk').platform, 'x');
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

describe('discordLookup snowflake', () => {
  const {
    isDiscordSnowflake,
    normalizeDiscordHandle,
    discordNotFoundMessage,
    discordIdHowToLines,
  } = require('../lib/discordLookup');

  it('recognizes snowflakes', () => {
    assert.equal(isDiscordSnowflake('123456789012345678'), true);
    assert.equal(isDiscordSnowflake('rudazy'), false);
  });

  it('strips legacy discriminator', () => {
    assert.equal(normalizeDiscordHandle('@bob#1234'), 'bob');
  });

  it('not-found copy teaches Copy User ID', () => {
    const t = discordNotFoundMessage((b) => `flizy ${b}`);
    assert.match(t, /Could not find that Discord name on Flizy/);
    assert.match(t, /Developer Mode/i);
    assert.match(t, /Copy User ID/i);
    assert.match(t, /on discord/);
    assert.match(t, /link Discord on Flizy/i);
  });

  it('how-to lines are short and numbered', () => {
    const lines = discordIdHowToLines();
    assert.ok(lines.some((l) => /1\)/.test(l)));
    assert.ok(lines.some((l) => /2\)/.test(l)));
    assert.ok(lines.some((l) => /3\)/.test(l)));
  });

  it('snowflake resolve does not use id as display handle', async () => {
    const { resolveDiscordUser } = require('../lib/discordLookup');
    const p = await resolveDiscordUser('845663947482857473');
    assert.equal(p.id, '845663947482857473');
    assert.equal(p.login, '');
  });
});

describe('platform claim receipt copy', () => {
  // Inline the same wording rules as router platformClaimLinkHowTo
  function howTo(channel) {
    const ch = String(channel || '').toLowerCase();
    if (ch === 'github') {
      return 'They receive after they link GitHub on Flizy (Account → Platforms → Link GitHub), then flizy claim or claim on the site.';
    }
    if (ch === 'discord') {
      return 'They receive after they link Discord on Flizy (Account → Platforms → Link Discord), then flizy claim or claim on the site.';
    }
    if (ch === 'x') {
      return 'They receive after they link X on Flizy (Account → Platforms → Link X), then flizy claim or claim on the site.';
    }
    return 'They receive after they link that platform on Flizy (Account → Platforms), then flizy claim or claim on the site.';
  }

  it('names Discord not GitHub for discord holds', () => {
    const t = howTo('discord');
    assert.match(t, /Link Discord/);
    assert.doesNotMatch(t, /GitHub/);
  });

  it('names GitHub for github holds', () => {
    assert.match(howTo('github'), /Link GitHub/);
  });
});
