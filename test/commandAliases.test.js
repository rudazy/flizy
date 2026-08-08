/**
 * Loose phrasing becomes a canonical command, and nothing else moves.
 *
 * The second half of this file is the important half: the canonicalizer sits in
 * front of every parser, including the send path, so the tests that assert it
 * leaves a command ALONE are what keep it safe to have there at all.
 *
 * Run: node --test test/commandAliases.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeCommand } = require('../lib/commandAliases');

// lib/runtime opens an RPC provider and demands real env; stub it for unit tests
const runtimePath = require.resolve('../lib/runtime');
require.cache[runtimePath] = {
  id: runtimePath,
  filename: runtimePath,
  loaded: true,
  exports: {
    chain: {
      id: 'giwa_sepolia',
      name: 'GIWA Sepolia',
      chainId: 91342,
      nativeSymbol: 'ETH',
      rpcUrl: 'http://localhost:0',
    },
    supabase: { from: () => ({}) },
    provider: {},
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

const {
  parseSwapCommand,
  parseSendCommand,
  parseRequestsCommand,
  isFlizyCommandBody,
  isFlizyCommand,
  normalizeInput,
} = require('../lib/router');

describe('canonicalizeCommand — price', () => {
  it('accepts the symbol before the word', () => {
    assert.equal(canonicalizeCommand('flz price'), 'price flz');
    assert.equal(canonicalizeCommand('FLZ rate'), 'price FLZ');
    assert.equal(canonicalizeCommand('flz worth'), 'price flz');
  });

  it('accepts "price of" and "price for"', () => {
    assert.equal(canonicalizeCommand('price of flz'), 'price flz');
    assert.equal(canonicalizeCommand('price for flz'), 'price flz');
  });

  it('accepts a plain question', () => {
    assert.equal(canonicalizeCommand("what's flz"), 'price flz');
    assert.equal(canonicalizeCommand('what is the flz price'), 'price flz');
    assert.equal(canonicalizeCommand('how much is flz'), 'price flz');
    assert.equal(canonicalizeCommand('how much is flz going for?'), 'price flz');
  });

  it('reads a bare price as FLZ, the only priced token', () => {
    assert.equal(canonicalizeCommand('price'), 'price FLZ');
  });

  it('ignores a trailing question mark', () => {
    assert.equal(canonicalizeCommand('flz price?'), 'price flz');
  });
});

describe('canonicalizeCommand — buy / sell / swap / trade', () => {
  it('maps buy synonyms', () => {
    assert.equal(canonicalizeCommand('get 100 flz'), 'buy 100 flz');
    assert.equal(canonicalizeCommand('purchase 100 flz'), 'buy 100 flz');
    assert.equal(canonicalizeCommand('buy 100 flz'), 'buy 100 flz');
  });

  it('keeps an explicit spend in the "of" shape', () => {
    assert.equal(canonicalizeCommand('buy 0.1 eth worth of flz'), 'buy 0.1 eth of flz');
    assert.equal(canonicalizeCommand('buy 0.1 eth of flz'), 'buy 0.1 eth of flz');
  });

  it('reorders "buy X with N Y" into the same shape', () => {
    assert.equal(canonicalizeCommand('buy flz with 0.1 eth'), 'buy 0.1 eth of flz');
  });

  it('maps sell synonyms', () => {
    assert.equal(canonicalizeCommand('cash out 50 flz'), 'sell 50 flz');
    assert.equal(canonicalizeCommand('cashout 50 flz'), 'sell 50 flz');
    assert.equal(canonicalizeCommand('dump 50 flz'), 'sell 50 flz');
  });

  it('maps swap synonyms and joining words', () => {
    assert.equal(canonicalizeCommand('convert 100 flz to eth'), 'swap 100 flz for eth');
    assert.equal(canonicalizeCommand('exchange 100 flz into eth'), 'swap 100 flz for eth');
    assert.equal(canonicalizeCommand('swap 100 flz for eth'), 'swap 100 flz for eth');
    assert.equal(canonicalizeCommand('trade 100 flz for eth'), 'swap 100 flz for eth');
    assert.equal(canonicalizeCommand('sell 50 flz for eth'), 'swap 50 flz for eth');
  });

  it('leaves a one-sided trade for the router to ask about', () => {
    assert.equal(canonicalizeCommand('trade 100 flz'), 'trade 100 flz');
    assert.equal(canonicalizeCommand('convert 100 flz'), 'trade 100 flz');
  });

  it('maps the save-wallet wording', () => {
    const addr = '0x1111111111111111111111111111111111111111';
    assert.equal(canonicalizeCommand(`save wallet ${addr}`), `add ${addr}`);
    assert.equal(canonicalizeCommand(`add wallet ${addr}`), `add ${addr}`);
  });
});

describe('canonicalizeCommand — send and pay', () => {
  const ADDR = '0x1111111111111111111111111111111111111111';

  it('maps the send synonyms', () => {
    assert.equal(canonicalizeCommand('pay 0.01 to john'), 'send 0.01 to john');
    assert.equal(canonicalizeCommand('transfer 0.01 to john'), 'send 0.01 to john');
    assert.equal(canonicalizeCommand('give 0.01 to john'), 'send 0.01 to john');
    assert.equal(canonicalizeCommand('wire 0.01 to john'), 'send 0.01 to john');
  });

  it('accepts the recipient first, the way people talk', () => {
    assert.equal(canonicalizeCommand('pay john 0.01'), 'send 0.01 to john');
    assert.equal(canonicalizeCommand('pay ama 10 flz'), 'send 10 flz to ama');
    assert.equal(canonicalizeCommand('send john 0.01'), 'send 0.01 to john');
  });

  it('carries every target shape through untouched', () => {
    // The point of capturing the tail as one opaque group: this layer never has
    // to know what a target looks like, so none of these can be mangled.
    const tails = [
      '0.01 to john',
      '10 flz to ama',
      '0.001 to @user on telegram',
      '0.001 to github:octocat',
      '0.001 to friend@email.com',
      '0.001 to email:friend@email.com',
      '0.01 to 2348012345678',
      `0.01 to ${ADDR}`,
    ];
    for (const tail of tails) {
      assert.equal(canonicalizeCommand(`pay ${tail}`), `send ${tail}`);
    }
  });

  it('moves a recipient-first target verbatim', () => {
    assert.equal(canonicalizeCommand('pay friend@email.com 0.5'), 'send 0.5 to friend@email.com');
    assert.equal(canonicalizeCommand(`pay ${ADDR} 0.01`), `send 0.01 to ${ADDR}`);
  });

  it('leaves bare pay alone — it still means incoming requests', () => {
    // parseRequestsCommand owns these. An amount is what makes it a send.
    assert.equal(canonicalizeCommand('pay'), 'pay');
    assert.equal(canonicalizeCommand('pay request'), 'pay request');
    assert.equal(canonicalizeCommand('pay requests'), 'pay requests');
    assert.equal(isFlizyCommandBody('pay'), true);
    assert.equal(parseRequestsCommand('pay').kind, 'incoming');
  });

  it('never reads an amount as the recipient', () => {
    // "pay 5 to john" must take the "to" road, never the recipient-first one.
    assert.equal(canonicalizeCommand('pay 5 to john'), 'send 5 to john');
    assert.equal(canonicalizeCommand('pay 0.5 to john'), 'send 0.5 to john');
  });

  it('resolves to the same recipient the parser would get from a typed send', () => {
    // The string being right is not the claim that matters. This is: whoever
    // parseSendCommand ends up paying must be who the user named.
    const pairs = [
      ['pay 0.01 to john', 'send 0.01 to john'],
      ['pay john 0.01', 'send 0.01 to john'],
      ['pay 10 flz to ama', 'send 10 flz to ama'],
      ['pay ama 10 flz', 'send 10 flz to ama'],
      ['pay 0.001 to @user on telegram', 'send 0.001 to @user on telegram'],
      ['pay 0.001 to github:octocat', 'send 0.001 to github:octocat'],
      ['pay 0.001 to friend@email.com', 'send 0.001 to friend@email.com'],
      ['pay friend@email.com 0.001', 'send 0.001 to friend@email.com'],
      ['pay 0.01 to 2348012345678', 'send 0.01 to 2348012345678'],
      [`pay 0.01 to ${ADDR}`, `send 0.01 to ${ADDR}`],
      [`pay ${ADDR} 0.01`, `send 0.01 to ${ADDR}`],
    ];

    for (const [loose, typed] of pairs) {
      const viaAlias = parseSendCommand(canonicalizeCommand(loose));
      const viaTyped = parseSendCommand(typed);
      assert.ok(viaAlias, `"${loose}" did not resolve to a send`);
      assert.deepEqual(viaAlias, viaTyped, `"${loose}" differs from "${typed}"`);
    }
  });
});

describe('canonicalizeCommand — must not touch anything else', () => {
  // If one of these ever changes, the canonicalizer has reached into a command
  // where an amount, an address or a recipient lives. That is the whole risk.
  const untouched = [
    'send 0.01 to john',
    'send 0.01 to 2348012345678',
    'send 0.01 to friend@email.com',
    'send 0.01 to @user on telegram',
    'send 0.01 to github:octocat',
    'send 0.01 to 0x1111111111111111111111111111111111111111',
    'send 10 FLZ to ama',
    'request 0.01 from john',
    'add ama 0x1111111111111111111111111111111111111111',
    'save ama 0x1111111111111111111111111111111111111111',
    'remove ama',
    'add 0x1111111111111111111111111111111111111111',
    'link ABC123',
    'unlock hunter2',
    'unlock my price is right',
    'lock',
    'balance',
    'claim',
    'claims',
    'confirm',
    'cancel',
    'help',
    'credit 2348012345678 0.01',
  ];

  for (const cmd of untouched) {
    it(`leaves "${cmd}" byte-identical`, () => {
      assert.equal(canonicalizeCommand(cmd), cmd);
    });
  }

  it('does not invent a command out of chatter', () => {
    assert.equal(canonicalizeCommand('hello there'), 'hello there');
    assert.equal(canonicalizeCommand(''), '');
  });
});

describe('parseSwapCommand — which side the amount names', () => {
  it('reads "buy 100 flz" as 100 FLZ received', () => {
    assert.deepEqual(parseSwapCommand('buy 100 flz'), {
      kind: 'buy',
      amountMode: 'out',
      amount: '100',
      tokenOut: 'flz',
    });
  });

  it('reads "buy 0.1 eth of flz" as 0.1 ETH spent', () => {
    assert.deepEqual(parseSwapCommand('buy 0.1 eth of flz'), {
      kind: 'buy',
      amountMode: 'in',
      amount: '0.1',
      tokenIn: 'eth',
      tokenOut: 'flz',
    });
  });

  it('keeps sell and swap on the spend side', () => {
    assert.equal(parseSwapCommand('sell 10 flz').amountMode, 'in');
    assert.equal(parseSwapCommand('swap 0.01 eth for flz').amountMode, 'in');
  });

  it('flags a one-sided trade instead of picking a direction', () => {
    assert.deepEqual(parseSwapCommand('trade 100 flz'), {
      kind: 'trade_ambiguous',
      amount: '100',
      symbol: 'flz',
    });
  });

  it('still parses price', () => {
    assert.deepEqual(parseSwapCommand('price FLZ'), { kind: 'price', symbol: 'FLZ' });
  });
});

describe('the WhatsApp wake gate sees loose commands', () => {
  // isFlizyCommand runs before normalizeInput, so a command the gate does not
  // recognise is dropped before any parser gets a look at it.
  const woken = [
    'flz price',
    'price of flz',
    "what's flz worth",
    'buy 100 flz',
    'buy 0.1 eth of flz',
    'get 100 flz',
    'cash out 50 flz',
    'swap 100 flz for eth',
    'trade 100 flz',
    'add 0x1111111111111111111111111111111111111111',
  ];

  for (const cmd of woken) {
    it(`wakes on "${cmd}"`, () => {
      assert.equal(isFlizyCommandBody(cmd), true);
    });
  }

  it('still ignores plain chatter', () => {
    assert.equal(isFlizyCommandBody('hey how are you'), false);
  });
});

describe('end to end: what a user actually types becomes a parsed command', () => {
  const wa = { channel: 'whatsapp', externalId: '2348012345678', key: 'whatsapp:2348012345678' };
  const tg = { channel: 'telegram', externalId: '778899123', key: 'telegram:778899123' };
  const ADDR = '0x9999999999999999999999999999999999999999';

  /** [what the user types on WhatsApp, the command the router ends up running] */
  const cases = [
    ['flizy flz price', 'price flz'],
    ['flizy buy 100 flz', 'buy 100 flz'],
    ['flizy swap 100 flz for eth', 'swap 100 flz for eth'],
    [`flizy add ${ADDR}`, `add ${ADDR}`],
    ['flizy trade 100 flz', 'trade 100 flz'],
  ];

  for (const [typed, expected] of cases) {
    it(`"${typed}" -> "${expected}"`, () => {
      assert.equal(isFlizyCommand(wa, typed), true, 'should wake the bot');
      assert.equal(normalizeInput(wa, typed).text, expected);
    });
  }

  it('the same commands work as bare slash commands on Telegram', () => {
    for (const [typed, expected] of cases) {
      const slash = `/${typed.replace(/^flizy /, '')}`;
      assert.equal(isFlizyCommand(tg, slash), true, `${slash} should wake the bot`);
      assert.equal(normalizeInput(tg, slash).text, expected);
    }
  });

  it('each resolved command reaches a parser', () => {
    for (const [, expected] of cases) {
      assert.equal(isFlizyCommandBody(expected), true, `${expected} has no parser`);
    }
  });
});
