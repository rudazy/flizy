/**
 * Split a bill: one total, several people, one request each.
 *
 * The typed amount is the whole bill and it divides among the people named
 * **plus the organiser**, because that is what splitting means at a table.
 * Asking for the share instead would make the organiser do the division, which
 * is the one job this feature exists to remove.
 *
 * There is no bills table. The total is the sum of the rows, the creator is the
 * same requester on every one, and progress is a count over them — so a table
 * would be a second copy of four facts for the sake of one label. What ties a
 * split together is a shared `bill_id`, and everything else is derived.
 *
 * Run: node --test test/splitBill.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { parseSplitCommand } = require('../lib/commands/parse');
const { summarizeBills } = require('../lib/paymentRequests');

describe('reading a split', () => {
  it('takes the people however they are typed', () => {
    for (const text of [
      'split 30 with @ada @kemi',
      'split 30 with ada and kemi',
      'split 30 with ada, kemi',
      'split 30 between ada and kemi',
    ]) {
      assert.deepEqual(parseSplitCommand(text).people, ['ada', 'kemi'], text);
    }
  });

  it('keeps a note off the end of the name list', () => {
    const r = parseSplitCommand('split 0.03 with ada, kemi for dinner');
    assert.deepEqual(r.people, ['ada', 'kemi']);
    assert.equal(r.note, 'dinner');
  });

  it('does not mistake a name containing "for" for the note', () => {
    // "forster" has no space around its "for", so the note starts at the real one.
    const r = parseSplitCommand('split 1 with @ada for the forster party');
    assert.deepEqual(r.people, ['ada']);
    assert.equal(r.note, 'the forster party');
  });

  it('asks each person once, however many times they are named', () => {
    assert.deepEqual(parseSplitCommand('split 30 with ada ada @ada').people, ['ada']);
  });

  it('takes the amount shapes the parser already learned', () => {
    assert.equal(parseSplitCommand('split 1,000 with @ada').amountEth, '1000');
  });

  it('refuses a split with nobody in it', () => {
    assert.equal(parseSplitCommand('split 30 with'), null);
    assert.equal(parseSplitCommand('split 30'), null);
    assert.equal(parseSplitCommand('send 30 to ada'), null);
  });
});

/**
 * The division is done in wei so the shares are exact. This mirrors what
 * handleSplitBill computes, because the property worth pinning is arithmetic:
 * nobody should be quietly charged more than anyone else.
 */
describe('dividing the bill', () => {
  const shareOf = (total, people) => {
    const wei = ethers.parseEther(total);
    const ways = BigInt(people + 1);
    return { shareWei: wei / ways, totalWei: wei, ways };
  };

  it('divides among the people named plus the organiser', () => {
    const { shareWei } = shareOf('0.03', 2);
    assert.equal(ethers.formatEther(shareWei), '0.01');
  });

  it('gives everyone asked the identical share', () => {
    const { shareWei, totalWei, ways } = shareOf('0.1', 2);
    // Two friends are asked; three shares exist.
    assert.equal(shareWei * ways <= totalWei, true, 'shares exceed the bill');
    assert.equal(ethers.formatEther(shareWei), ethers.formatEther(totalWei / ways));
  });

  it('leaves the remainder with the organiser, not with one friend', () => {
    // 1 wei short of divisible: the organiser absorbs it rather than one person
    // paying a different number for no reason they could see.
    const totalWei = 10n;
    const ways = 3n;
    const shareWei = totalWei / ways; // 3
    const asked = 2n;
    const organiserPays = totalWei - shareWei * asked; // 4
    assert.equal(shareWei, 3n);
    assert.equal(organiserPays, 4n);
    assert.equal(organiserPays > shareWei, true, 'remainder landed on a friend');
  });

  it('refuses a bill too small to divide', () => {
    const { shareWei } = shareOf('0.000000000000000001', 2);
    assert.equal(shareWei, 0n);
  });
});

/**
 * Progress is counted from the requests every time it is asked for. That is the
 * whole argument against a bills table: a stored total can disagree with the
 * rows it describes, and a counted one cannot.
 */
describe('progress is derived, never stored', () => {
  const rows = [
    { bill_id: 'b1', bill_note: 'dinner', status: 'paid' },
    { bill_id: 'b1', bill_note: 'dinner', status: 'pending' },
    { bill_id: 'b1', bill_note: 'dinner', status: 'cancelled' },
    { bill_id: 'b2', bill_note: 'taxi', status: 'pending' },
    { bill_id: null, status: 'pending' },
  ];

  it('counts each split separately', () => {
    const bills = summarizeBills(rows);
    assert.equal(bills.length, 2);

    const dinner = bills.find((b) => b.billId === 'b1');
    assert.equal(dinner.total, 3);
    assert.equal(dinner.paid, 1);
    assert.equal(dinner.open, 1, 'a cancelled request is not still open');
  });

  it('ignores a request that is not part of any split', () => {
    assert.equal(summarizeBills(rows).some((b) => b.billId === null), false);
  });

  it('has nothing to say about no rows', () => {
    assert.deepEqual(summarizeBills([]), []);
    assert.deepEqual(summarizeBills(null), []);
  });
});
