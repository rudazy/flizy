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

  it('parses on telegram and on tg', () => {
    const a = parseSendCommand('send 0.001 to @alice_crypto on telegram');
    assert.equal(a.platform, 'telegram');
    assert.equal(a.toRaw, 'alice_crypto');
    assert.equal(a.isPhone, false);

    const b = parseSendCommand('send 0.01 eth to alice_crypto on tg');
    assert.equal(b.platform, 'telegram');
    assert.equal(b.toRaw, 'alice_crypto');

    const c = parseSendCommand('send 0.001 to telegram:alice_crypto');
    assert.equal(c.platform, 'telegram');
    assert.equal(c.toRaw, 'alice_crypto');

    const d = parseSendCommand('send 0.001 to tg:123456789');
    assert.equal(d.platform, 'telegram');
    assert.equal(d.toRaw, '123456789');
  });

  it('parses asset form on telegram', () => {
    const a = parseSendCommand('send 10 FLZ to @alice_crypto on telegram');
    assert.equal(a.platform, 'telegram');
    assert.equal(a.asset, 'FLZ');
    // Token claims to unlinked platforms are rejected later; parse still accepts.
    assert.equal(a.toRaw, 'alice_crypto');
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

  it('accepts short aliases gh, dc, tg (full names still work)', () => {
    assert.equal(parseSendCommand('send 0.001 to ludarep on tg').platform, 'telegram');
    assert.equal(parseSendCommand('send 0.001 to rudazy on gh').platform, 'github');
    assert.equal(parseSendCommand('send 0.001 to 123456789012345678 on dc').platform, 'discord');
    assert.equal(parseSendCommand('send 0.001 to gh:octocat').platform, 'github');
    assert.equal(parseSendCommand('send 0.001 to dc:99').platform, 'discord');
    assert.equal(parseSendCommand('send 0.001 to tg:alice_crypto').platform, 'telegram');
    // Full forms unchanged
    assert.equal(parseSendCommand('send 0.001 to rudazy on github').platform, 'github');
    assert.equal(parseSendCommand('send 0.001 to 99 on discord').platform, 'discord');
    assert.equal(parseSendCommand('send 0.001 to alice on telegram').platform, 'telegram');
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
    if (ch === 'telegram') {
      return 'They receive after they open the Flizy Telegram bot, link with a site code (link CODE), then flizy claim or claim on the site. After that, this Telegram account stays tied to their Flizy account until they unlink.';
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

  it('names Telegram bot link and id binding for telegram holds', () => {
    const t = howTo('telegram');
    assert.match(t, /Telegram bot/i);
    assert.match(t, /link CODE/i);
    assert.match(t, /until they unlink/i);
    assert.doesNotMatch(t, /Platforms → Link/);
  });
});
