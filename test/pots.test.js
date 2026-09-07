/**
 * Named pots: group money that exists before anyone is asked.
 *
 * A pot is the one thing split bill deliberately is not -- a row. The tests
 * that matter most here are the two properties that keep it honest:
 *
 *   1. The running total is counted, never stored, and counts only money that
 *      actually landed.
 *   2. Whatever routes must also wake WhatsApp, or a reply exists on a path the
 *      bot never answers on.
 *
 * Run: node --test test/pots.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  POT_CODE_FORMAT,
  POT_NAME_MAX,
  POT_STATUS,
  normalizePotCode,
  isPotCodeFormat,
  mintPotCode,
  normalizePotName,
  potProgressLine,
  potIsFunded,
  formatPotsMenu,
  formatPotDetail,
} = require('../lib/pots');

const {
  parseCollectCommand,
  parsePotCommand,
  parsePotsListCommand,
  parsePayPotCommand,
  parsePayPotNoAmountCommand,
  parseClosePotCommand,
  parseRenamePotCommand,
  isFlizyCommandBody,
} = require('../lib/commands/parse');

const { renderCommands } = require('../lib/commands/render');

describe('reading a collect', () => {
  it('takes a goal and a name', () => {
    assert.deepEqual(parseCollectCommand('collect 5 for rent'), {
      amountEth: '5',
      name: 'rent',
    });
  });

  it('takes the eth unit without changing the meaning', () => {
    assert.deepEqual(parseCollectCommand('collect 5 eth for rent').amountEth, '5');
  });

  it('allows a pot with no goal', () => {
    assert.deepEqual(parseCollectCommand('collect for team lunch'), {
      amountEth: null,
      name: 'team lunch',
    });
    assert.deepEqual(parseCollectCommand('collect rent money'), {
      amountEth: null,
      name: 'rent money',
    });
  });

  it('takes the grouped amounts the parser already learned', () => {
    assert.equal(parseCollectCommand('collect 1,000 for hall').amountEth, '1000');
  });

  it('refuses a goal with nothing to call the pot', () => {
    // "collect 5" is a number and no name. Reading it as a pot called "5" would
    // create something nobody could recognise in a list.
    assert.equal(parseCollectCommand('collect 5'), null);
    assert.equal(parseCollectCommand('collect 5 eth'), null);
    assert.equal(parseCollectCommand('collect'), null);
  });

  it('does not read the goal as part of the name', () => {
    assert.equal(parseCollectCommand('collect 5 for rent').name, 'rent');
  });
});

describe('the other pot verbs', () => {
  it('lists on pots or pot alone', () => {
    assert.equal(parsePotsListCommand('pots'), true);
    assert.equal(parsePotsListCommand('pot'), true);
    assert.equal(parsePotsListCommand('pot k7m2q4'), false);
  });

  it('reads a pot by code', () => {
    assert.deepEqual(parsePotCommand('pot k7m2q4'), { code: 'k7m2q4' });
    assert.deepEqual(parsePotCommand('POT K7M2Q4'), { code: 'k7m2q4' });
  });

  it('takes a contribution either way round', () => {
    const expected = { code: 'k7m2q4', amountEth: '1.5' };
    assert.deepEqual(parsePayPotCommand('pay pot k7m2q4 1.5'), expected);
    assert.deepEqual(parsePayPotCommand('pay 1.5 to pot k7m2q4'), expected);
    assert.deepEqual(parsePayPotCommand('pay 1.5 into pot k7m2q4'), expected);
  });

  it('separates a contribution with no amount from one with', () => {
    // Both shapes exist so the handler can say what is missing rather than
    // letting "pay pot k7m2q4" fall through to unknown command.
    assert.equal(parsePayPotNoAmountCommand('pay pot k7m2q4 1.5'), null);
    assert.deepEqual(parsePayPotNoAmountCommand('pay pot k7m2q4'), { code: 'k7m2q4' });
  });

  it('closes and renames', () => {
    assert.deepEqual(parseClosePotCommand('close pot k7m2q4'), { code: 'k7m2q4' });
    assert.deepEqual(parseRenamePotCommand('rename pot k7m2q4 rent for october'), {
      code: 'k7m2q4',
      name: 'rent for october',
    });
    assert.equal(parseRenamePotCommand('rename pot k7m2q4'), null);
  });
});

/**
 * The lesson from the amount-parsing work: the WhatsApp gate is a separate list
 * from the router, so a command can route and still never be answered.
 *
 * The gate sees the body with any `flizy` prefix already stripped, which is why
 * only the bare forms are asserted here.
 */
describe('whatever routes must also wake WhatsApp', () => {
  const routable = [
    'collect 5 for rent',
    'collect for team lunch',
    'collect rent money',
    'pots',
    'pot',
    'pot k7m2q4',
    'pay pot k7m2q4 1.5',
    'pay 1.5 to pot k7m2q4',
    'pay pot k7m2q4',
    'close pot k7m2q4',
    'rename pot k7m2q4 new name',
  ];

  for (const body of routable) {
    it(`wakes for "${body}"`, () => {
      assert.equal(isFlizyCommandBody(body), true, body);
    });
  }

  it('does not wake for a bare number that names nothing', () => {
    assert.equal(isFlizyCommandBody('collect 5'), false);
  });
});

describe('pot codes', () => {
  it('mints codes in the stated format', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = mintPotCode();
      assert.match(code, POT_CODE_FORMAT, code);
    }
  });

  it('leaves out glyphs that get confused when read aloud', () => {
    // No 0/o, 1/l/i. A pot code is retyped from a chat message by hand.
    for (let i = 0; i < 200; i += 1) {
      assert.equal(/[01ilo]/.test(mintPotCode()), false);
    }
  });

  it('can never be mistaken for a nine-digit pay code', () => {
    for (let i = 0; i < 200; i += 1) {
      assert.equal(/^[0-9]{9}$/.test(mintPotCode()), false);
    }
  });

  it('reduces what a human might paste to the stored form', () => {
    assert.equal(normalizePotCode(' K7M2-Q4 '), 'k7m2q4');
    assert.equal(isPotCodeFormat('K7M2Q4'), true);
    assert.equal(isPotCodeFormat('short'), false);
  });
});

describe('pot names', () => {
  it('collapses whitespace and trims', () => {
    assert.equal(normalizePotName('  rent   for  october '), 'rent for october');
  });

  it('refuses a blank name', () => {
    assert.equal(normalizePotName('   '), null);
    assert.equal(normalizePotName(null), null);
  });

  it('caps the length so a menu line cannot be flooded', () => {
    assert.equal(normalizePotName('x'.repeat(500)).length, POT_NAME_MAX);
  });
});

/**
 * The argument against a balance column: a stored total can disagree with the
 * rows it describes. These pin what the counted one must say.
 */
describe('progress is counted, and only from money that landed', () => {
  const openPot = { id: 'p1', name: 'rent', target_eth: '5', status: POT_STATUS.OPEN };
  const openEnded = { id: 'p2', name: 'lunch', target_eth: null, status: POT_STATUS.OPEN };

  it('reads against the goal when there is one', () => {
    assert.equal(potProgressLine(openPot, { totalEth: 1.5 }), '1.5 of 5 ETH');
  });

  it('has no finish line when there is no goal', () => {
    assert.equal(potProgressLine(openEnded, { totalEth: 1.5 }), '1.5 ETH in');
  });

  it('is zero, not blank, before anyone pays', () => {
    assert.equal(potProgressLine(openPot, undefined), '0 of 5 ETH');
  });

  it('counts a pot funded at the goal and past it', () => {
    assert.equal(potIsFunded(openPot, { totalEth: 4.9 }), false);
    assert.equal(potIsFunded(openPot, { totalEth: 5 }), true);
    assert.equal(potIsFunded(openPot, { totalEth: 7 }), true, 'overshooting still counts');
  });

  it('never calls an open-ended pot funded', () => {
    // No goal is not the same as unmet. A thrift pot has no finish line.
    assert.equal(potIsFunded(openEnded, { totalEth: 1000 }), false);
  });
});

describe('what the organiser and a contributor see', () => {
  const pot = { id: 'p1', code: 'k7m2q4', name: 'rent', target_eth: '5', status: POT_STATUS.OPEN };

  it('tells a first-time user how to start one', () => {
    const t = formatPotsMenu([], new Map());
    assert.match(t, /No pots yet/);
    assert.match(renderCommands(t, 'telegram'), /\/collect 5 for rent/);
    assert.match(renderCommands(t, 'whatsapp'), /flizy collect 5 for rent/);
  });

  it('shows the code, because the code is what gets shared', () => {
    const totals = new Map([['p1', { totalEth: 1.5, count: 1, contributors: 1 }]]);
    assert.match(formatPotsMenu([pot], totals), /k7m2q4/);
  });

  it('offers closing only to the organiser', () => {
    const totals = { totalEth: 1.5, count: 1, contributors: 1 };
    assert.match(formatPotDetail(pot, totals, [], { mine: true }), /\{\{cmd:close pot k7m2q4\}\}/);
    assert.doesNotMatch(formatPotDetail(pot, totals, [], { mine: false }), /close pot/);
  });

  it('says a closed pot is closed and stops inviting payment', () => {
    const closed = { ...pot, status: POT_STATUS.CLOSED };
    const t = formatPotDetail(closed, { totalEth: 5, count: 1, contributors: 1 }, []);
    assert.match(t, /Closed/);
    assert.doesNotMatch(t, /Pay in/);
  });

  it('says a funded pot is still open, because overshooting is allowed', () => {
    const t = formatPotDetail(pot, { totalEth: 6, count: 2, contributors: 2 }, []);
    assert.match(t, /Goal reached\. Still open\./);
    assert.match(t, /Pay in/);
  });

  it('counts people separately from payments', () => {
    const t = formatPotDetail(pot, { totalEth: 3, count: 3, contributors: 2 }, []);
    assert.match(t, /2 people, 3 payments/);
  });

  it('renders the pay-in command in each channel dialect', () => {
    const t = formatPotDetail(pot, { totalEth: 0, count: 0, contributors: 0 }, []);
    assert.match(renderCommands(t, 'telegram'), /\/pay pot k7m2q4 1/);
    assert.match(renderCommands(t, 'whatsapp'), /flizy pay pot k7m2q4 1/);
  });
});
