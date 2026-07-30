/**
 * What escrow solvency means, pinned.
 *
 * assertEscrowSolvent used to compute two answers next to each other:
 *
 *   const ok = balance >= liability + extra + gas || balance >= liability + extra;  // unused
 *   return { ok: balance >= liability + extra, ... };                              // used
 *
 * The unused one was a tautology. Its first disjunct implies its second whenever
 * the gas buffer is not negative, so `A || B` collapsed to B, which is exactly
 * what was already being returned. Deleting it changed no behaviour, and these
 * tests are here so the two ideas cannot silently merge again: ok is about money
 * owed to users, strictOk is about also having gas for the next payout.
 *
 * Run: node --test test/escrowSolvency.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

// A dedicated escrow key, so the fallback derivation from ops material is not
// exercised here and no real key is needed.
process.env.ESCROW_PRIVATE_KEY = `0x${'11'.repeat(32)}`;

let fake = createFakeSupabase({ claims: [] });
mockSupabaseModule({ from: (table) => fake.client.from(table) });

const { assertEscrowSolvent, getPendingClaimsLiability } = require('../lib/escrowWallet');
const { config } = require('../lib/config');

const GAS_BUFFER = config.gasBufferEth;

function providerWith(balanceEth) {
  return { getBalance: async () => ethers.parseEther(String(balanceEth)) };
}

function seedClaims(rows) {
  fake = createFakeSupabase({ claims: rows });
  mockSupabaseModule({ from: (table) => fake.client.from(table) });
}

describe('pending liability is what escrow owes users', () => {
  beforeEach(() => {
    seedClaims([
      { id: 'c1', amount_eth: '0.5', status: 'pending' },
      { id: 'c2', amount_eth: '0.25', status: 'processing' },
      { id: 'c3', amount_eth: '1.0', status: 'claimed' },
      { id: 'c4', amount_eth: '2.0', status: 'cancelled' },
    ]);
  });

  it('counts pending and processing, nothing else', async () => {
    const l = await getPendingClaimsLiability();
    assert.equal(l.count, 2);
    assert.equal(l.liabilityEth, '0.75');
  });
});

describe('ok answers "can escrow cover what it owes"', () => {
  beforeEach(() => {
    seedClaims([{ id: 'c1', amount_eth: '1.0', status: 'pending' }]);
  });

  it('is true when the balance exactly equals the liability', async () => {
    // The concrete case the two expressions were argued over: 1.0 owed, 1.0
    // held, no gas headroom at all. Solvent, and not ready for a payout.
    const s = await assertEscrowSolvent(providerWith('1.0'));
    assert.equal(s.ok, true);
    assert.equal(s.strictOk, false);
    assert.equal(s.shortfallEth, '0');
  });

  it('is false as soon as the balance is under the liability', async () => {
    const s = await assertEscrowSolvent(providerWith('0.9'));
    assert.equal(s.ok, false);
    assert.equal(s.strictOk, false);
    assert.equal(s.shortfallEth, '0.1');
  });

  it('is true with room to spare, and strict too', async () => {
    const s = await assertEscrowSolvent(providerWith('2.0'));
    assert.equal(s.ok, true);
    assert.equal(s.strictOk, true);
  });

  it('counts a hold being placed right now via extraWei', async () => {
    const extraWei = ethers.parseEther('0.5');
    const short = await assertEscrowSolvent(providerWith('1.2'), { extraWei });
    assert.equal(short.ok, false);
    assert.equal(short.shortfallEth, '0.3');

    const fine = await assertEscrowSolvent(providerWith('1.5'), { extraWei });
    assert.equal(fine.ok, true);
  });
});

describe('the deleted expression was equivalent to the kept one', () => {
  beforeEach(() => {
    seedClaims([{ id: 'c1', amount_eth: '1.0', status: 'pending' }]);
  });

  it('agrees on every balance either side of both thresholds', async () => {
    const gas = Number(GAS_BUFFER);
    const balances = ['0', '0.5', '0.999999', '1.0', String(1 + gas / 2), String(1 + gas), '1.5'];

    for (const balance of balances) {
      const s = await assertEscrowSolvent(providerWith(balance));
      const balanceWei = ethers.parseEther(balance);
      const owedWei = ethers.parseEther('1.0');
      const gasWei = ethers.parseEther(String(GAS_BUFFER));

      // What the dead line computed, spelled out
      const deadOk = balanceWei >= owedWei + gasWei || balanceWei >= owedWei;
      assert.equal(s.ok, deadOk, `balance=${balance}`);
      // And what it is actually equivalent to
      assert.equal(s.ok, balanceWei >= owedWei, `balance=${balance}`);
    }
  });

  it('keeps the gas question separate and answerable', async () => {
    // Between the two thresholds is the only interesting window, and it is the
    // one where ok and strictOk must disagree.
    const between = String(1 + Number(GAS_BUFFER) / 2);
    const s = await assertEscrowSolvent(providerWith(between));
    assert.equal(s.ok, true);
    assert.equal(s.strictOk, false);
  });
});
