/**
 * The smart-account executor (executeGatorCall), against a scripted chain:
 * per-call gas with a floor and a ceiling, refusal on a failed estimate, the
 * in-executor prefund check, the hash recorded before broadcast, an unknown
 * outcome reported as submitted, and reads that are never older than the
 * account's last receipt. Every scenario runs against both mirrors
 * (lib/gatorExecute.js and web/lib/gatorExecute.ts), so they cannot drift in
 * behaviour, not only in constants.
 *
 * No network: the provider below is a plain object.
 *
 * Run: node --test test/gatorExecuteHardening.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
// A throwaway submitter key for signing in tests; nothing is ever sent.
process.env.PRIVATE_KEY = '0x' + '11'.repeat(32);

const bot = require('../lib/gatorExecute');
const { gatorAddresses, predictGatorAddress } = require('../lib/gatorAccount');
let web;
before(async () => {
  web = await import('../web/lib/gatorExecute.ts');
});

const EP = gatorAddresses().entryPointV07;
const ACCOUNT = 'acct-hardening';
const GATOR = predictGatorAddress(ACCOUNT);
const TARGET = '0x2222222222222222222222222222222222222222';
const GWEI = 10n ** 9n;
const EPI = new ethers.Interface([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'error FailedOp(uint256 opIndex, string reason)',
]);

const revertErr = (data = '0x8199f5f3') => Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data });
const networkErr = () => Object.assign(new Error('request timeout'), { code: 'TIMEOUT' });
const missingBlock = () => new Error('header not found');

/**
 * A scripted chain. Options:
 *   inner(tx, state)   inner-call estimate: a bigint, or throw
 *   outer(tx, state)   handleOps estimate: a bigint, or throw
 *   balance            gator ETH balance
 *   deposit            gator EntryPoint deposit
 *   nonce              EntryPoint nonce
 *   lagReads           first N pinned reads answer "header not found"
 *   broadcast(raw)     throw to simulate a broadcast failure
 *   receipt(hash)      the receipt waitForTransaction returns (null = none)
 */
function makeChain(opts = {}) {
  const state = { head: 100, broadcasts: [], innerCalls: 0, outerCalls: 0, pinnedTags: [], lag: opts.lagReads || 0 };
  const pinned = (tag) => {
    if (typeof tag === 'number') state.pinnedTags.push(tag);
    if (state.lag > 0 && typeof tag === 'number') {
      state.lag -= 1;
      throw missingBlock();
    }
  };
  const provider = {
    async getNetwork() {
      return { chainId: 91342n };
    },
    async getCode() {
      return '0x6080';
    },
    async getBlockNumber() {
      return state.head;
    },
    async getFeeData() {
      return { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI, gasPrice: null };
    },
    async getTransactionCount() {
      return 7;
    },
    async estimateGas(tx) {
      if (tx.to && ethers.getAddress(tx.to) === ethers.getAddress(EP)) {
        state.outerCalls += 1;
        return opts.outer ? opts.outer(tx, state) : 400_000n;
      }
      pinned(tx.blockTag);
      state.innerCalls += 1;
      return opts.inner ? opts.inner(tx, state) : 60_000n;
    },
    async call(tx) {
      pinned(tx.blockTag);
      const sel = String(tx.data).slice(0, 10);
      if (sel === EPI.getFunction('getNonce').selector) return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [opts.nonce ?? 3n]);
      if (sel === EPI.getFunction('balanceOf').selector) return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [opts.deposit ?? 0n]);
      throw new Error(`unexpected call ${sel}`);
    },
    async getBalance(_addr, tag) {
      pinned(tag);
      return opts.balance ?? 10n ** 18n;
    },
    async broadcastTransaction(raw) {
      if (opts.broadcast) opts.broadcast(raw);
      state.broadcasts.push(raw);
      return { hash: ethers.keccak256(raw) };
    },
    async waitForTransaction(hash) {
      if (opts.receipt) return opts.receipt(hash, state);
      return receiptFor(hash, true, state.head + 1);
    },
  };
  return { provider, state };
}

function receiptFor(hash, success, blockNumber = 101) {
  const ev = EPI.getEvent('UserOperationEvent');
  const log = EPI.encodeEventLog(ev, [ethers.ZeroHash, GATOR, ethers.ZeroAddress, 3n, success, 1n, 1n]);
  return { hash, status: 1, blockNumber, to: EP, logs: [{ address: EP, topics: log.topics, data: log.data }] };
}

/** The call gas the broadcast UserOp declared. */
function declaredCallGas(raw) {
  const tx = ethers.Transaction.from(raw);
  const op = EPI.decodeFunctionData('handleOps', tx.data).ops[0];
  return BigInt(op.accountGasLimits) & ((1n << 128n) - 1n);
}

const sides = () => [
  ['bot', bot],
  ['web', web],
];

async function run(m, chain, extra = {}) {
  m.lastReceiptBlock.clear();
  return m.executeGatorCall({ accountId: ACCOUNT, provider: chain.provider, chainId: 91342, target: TARGET, value: 0n, data: '0x', ...extra });
}

describe('call gas: estimate + 20%, floor 500,000, ceiling 1,000,000', () => {
  it('constants agree on both sides', () => {
    assert.equal(bot.GATOR_CALL_GAS_FLOOR, 500_000n);
    assert.equal(bot.GATOR_CALL_GAS_CEILING, 1_000_000n);
    assert.equal(web.GATOR_CALL_GAS_FLOOR, bot.GATOR_CALL_GAS_FLOOR);
    assert.equal(web.GATOR_CALL_GAS_CEILING, bot.GATOR_CALL_GAS_CEILING);
    assert.equal(web.GATOR_USEROP_GAS, bot.GATOR_USEROP_GAS);
  });

  it('clamps up to the floor, so no existing flow gets less', () => {
    for (const m of [bot, web]) {
      assert.equal(m.callGasFor(1n), 500_000n);
      assert.equal(m.callGasFor(29_013n), 500_000n);
      assert.equal(m.callGasFor(416_666n), 500_000n);
    }
  });

  it('adds 20% in integers, rounded up', () => {
    for (const m of [bot, web]) {
      assert.equal(m.callGasFor(500_000n), 600_000n);
      assert.equal(m.callGasFor(500_001n), 600_002n);
      assert.equal(m.callGasFor(510_730n), 612_876n);
      assert.equal(m.callGasFor(416_667n), 500_001n);
    }
  });

  it('allows exactly the ceiling and refuses one gas above it', () => {
    for (const m of [bot, web]) {
      assert.equal(m.callGasFor(833_333n), 1_000_000n);
      assert.equal(m.callGasFor(833_334n), null);
    }
  });

  it('both sides give the same answer across the range', () => {
    for (let e = 0n; e < 900_000n; e += 7_919n) assert.equal(web.callGasFor(e), bot.callGasFor(e), String(e));
  });

  it('prefund is exact for the declared gas and agrees on both sides', () => {
    assert.equal(bot.prefundRequiredWei(612_876n, GWEI, 0n), (1_000_000n + 612_876n + 80_000n) * GWEI);
    assert.equal(bot.prefundRequiredWei(500_000n, GWEI, 10n ** 18n), 0n);
    assert.equal(web.prefundRequiredWei(612_876n, GWEI, 5n), bot.prefundRequiredWei(612_876n, GWEI, 5n));
  });

  it('error copy is the same, short, and never carries RPC text', () => {
    assert.deepEqual({ ...web.GATOR_ERROR_COPY }, { ...bot.GATOR_ERROR_COPY });
    assert.equal(bot.GATOR_ERROR_COPY.WOULD_REVERT, 'This would fail right now, so nothing was sent.');
    assert.equal(bot.GATOR_ERROR_COPY.INSUFFICIENT_GAS_FUNDS, 'Not enough ETH to cover the network fee, so nothing was sent.');
    assert.notEqual(bot.GATOR_ERROR_COPY.INSUFFICIENT_GAS_FUNDS, bot.GATOR_ERROR_COPY.WOULD_REVERT);
    assert.match(bot.GATOR_ERROR_COPY.OUTCOME_UNKNOWN, /^Sent, and still confirming/);
    for (const text of Object.values(bot.GATOR_ERROR_COPY)) {
      assert.doesNotMatch(text, /0x|revert|rpc|execution|AA\d\d/i);
    }
  });
});

for (const [side] of [['bot'], ['web']]) {
  const m = () => (side === 'bot' ? bot : web);

  describe(`${side}: the executor sends with per-call gas`, () => {
    it('declares the buffered estimate as call gas', async () => {
      const chain = makeChain({ inner: () => 510_730n });
      const res = await run(m(), chain);
      assert.equal(res.callGasLimit, 612_876n);
      assert.equal(declaredCallGas(chain.state.broadcasts[0]), 612_876n);
    });

    it('a small call keeps the old 500,000', async () => {
      const chain = makeChain({ inner: () => 21_000n });
      await run(m(), chain);
      assert.equal(declaredCallGas(chain.state.broadcasts[0]), 500_000n);
    });

    it('above the ceiling: refused, nothing sent', async () => {
      const chain = makeChain({ inner: () => 900_000n });
      await assert.rejects(run(m(), chain), (e) => e.code === 'GAS_CEILING' && e.submitted === false);
      assert.equal(chain.state.broadcasts.length, 0);
      assert.equal(chain.state.outerCalls, 0);
    });
  });

  describe(`${side}: a failed estimate never sends`, () => {
    it('a revert refuses with WOULD_REVERT and clean copy', async () => {
      const chain = makeChain({ inner: () => { throw revertErr(); } });
      let seen = false;
      await assert.rejects(run(m(), chain, { onBroadcast: () => { seen = true; } }), (e) => {
        assert.equal(e.code, 'WOULD_REVERT');
        assert.equal(e.submitted, false);
        assert.equal(e.reason, '0x8199f5f3');
        assert.equal(m().gatorErrorCopy(e), 'This would fail right now, so nothing was sent.');
        return true;
      });
      assert.equal(seen, false);
      assert.equal(chain.state.broadcasts.length, 0);
      assert.equal(chain.state.innerCalls, 1, 'a revert is not retried');
    });

    it('a network error is retried once, and then it sends', async () => {
      const chain = makeChain({
        inner: (_tx, st) => {
          if (st.innerCalls === 1) throw networkErr();
          return 60_000n;
        },
      });
      await run(m(), chain);
      assert.equal(chain.state.innerCalls, 2);
      assert.equal(chain.state.broadcasts.length, 1);
    });

    it('a network error twice refuses with ESTIMATE_UNAVAILABLE, nothing sent', async () => {
      const chain = makeChain({ inner: () => { throw networkErr(); } });
      await assert.rejects(run(m(), chain), (e) => e.code === 'ESTIMATE_UNAVAILABLE' && e.submitted === false);
      assert.equal(chain.state.innerCalls, 2);
      assert.equal(chain.state.broadcasts.length, 0);
    });
  });

  describe(`${side}: the account must cover value plus the prefund for this call's gas`, () => {
    const need = (gas) => (1_000_000n + gas + 80_000n) * 2n * GWEI;

    it('refuses with INSUFFICIENT_GAS_FUNDS, nothing sent', async () => {
      const chain = makeChain({ inner: () => 510_730n, balance: need(612_876n) - 1n });
      await assert.rejects(run(m(), chain), (e) => e.code === 'INSUFFICIENT_GAS_FUNDS' && e.submitted === false);
      assert.equal(chain.state.broadcasts.length, 0);
    });

    it('uses the per-call gas, not the fixed floor', async () => {
      // Enough for a 500,000 op, not for this 612,876 one.
      const chain = makeChain({ inner: () => 510_730n, balance: need(500_000n) });
      await assert.rejects(run(m(), chain), (e) => e.code === 'INSUFFICIENT_GAS_FUNDS');
      const enough = makeChain({ inner: () => 510_730n, balance: need(612_876n) });
      await run(m(), enough);
      assert.equal(enough.state.broadcasts.length, 1);
    });

    it('counts the EntryPoint deposit and the value sent', async () => {
      const chain = makeChain({ inner: () => 60_000n, balance: 5n, deposit: need(500_000n) });
      await assert.rejects(run(m(), chain, { value: 6n }), (e) => e.code === 'INSUFFICIENT_GAS_FUNDS');
      const ok = makeChain({ inner: () => 60_000n, balance: 6n, deposit: need(500_000n) });
      await run(m(), ok, { value: 6n });
    });
  });

  describe(`${side}: the hash is recorded before broadcast`, () => {
    it('onBroadcast gets the real hash before the broadcast happens', async () => {
      const chain = makeChain();
      let recorded = null;
      let broadcastsAtRecord = null;
      const res = await run(m(), chain, {
        onBroadcast: (hash) => {
          recorded = hash;
          broadcastsAtRecord = chain.state.broadcasts.length;
        },
      });
      assert.equal(broadcastsAtRecord, 0);
      assert.equal(recorded, ethers.keccak256(chain.state.broadcasts[0]));
      assert.equal(res.txHash, recorded);
    });

    it('a record that cannot be written stops the broadcast', async () => {
      const chain = makeChain();
      await assert.rejects(
        run(m(), chain, { onBroadcast: () => { throw new Error('db down'); } }),
        (e) => e.code === 'RECORD_FAILED' && e.submitted === false
      );
      assert.equal(chain.state.broadcasts.length, 0);
    });
  });

  describe(`${side}: after broadcast, an unanswered send is UNKNOWN, not failed`, () => {
    it('a broadcast that times out is submitted, with its hash', async () => {
      const chain = makeChain({ broadcast: () => { throw networkErr(); } });
      let recorded;
      await assert.rejects(run(m(), chain, { onBroadcast: (h) => { recorded = h; } }), (e) => {
        assert.equal(e.code, 'OUTCOME_UNKNOWN');
        assert.equal(e.submitted, true);
        assert.equal(e.txHash, recorded);
        assert.equal(m().outcomeUnknown(e), true);
        assert.match(m().gatorErrorCopy(e), /^Sent, and still confirming/);
        return true;
      });
    });

    it('no receipt in time is submitted', async () => {
      const chain = makeChain({ receipt: () => null });
      await assert.rejects(run(m(), chain), (e) => e.code === 'OUTCOME_UNKNOWN' && e.submitted === true && /^0x[0-9a-f]{64}$/.test(e.txHash));
    });

    it('a node that refuses the transaction is not submitted', async () => {
      const chain = makeChain({ broadcast: () => { throw Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' }); } });
      await assert.rejects(run(m(), chain), (e) => e.code === 'BROADCAST_REJECTED' && e.submitted === false);
    });

    it('a mined inner revert is known: not submitted, with the hash', async () => {
      const chain = makeChain({ receipt: (hash) => receiptFor(hash, false) });
      await assert.rejects(run(m(), chain), (e) => e.code === 'USEROP_REVERTED' && e.submitted === false && Boolean(e.txHash));
    });

    it('an approval left unconfirmed is reported as not sent', async () => {
      const chain = makeChain({ receipt: () => null });
      m().lastReceiptBlock.clear();
      await assert.rejects(
        m().executeApprovalCall({ accountId: ACCOUNT, provider: chain.provider, chainId: 91342, target: TARGET, value: 0n, data: '0x' }),
        (e) => e.code === 'APPROVAL_UNCONFIRMED' && e.submitted === false
      );
    });
  });

  describe(`${side}: reads are never older than this account's last receipt`, () => {
    it('pins nonce, balance, deposit and estimate to the last receipt block or later', async () => {
      const chain = makeChain({ receipt: (hash) => receiptFor(hash, true, 140) });
      await run(m(), chain);
      assert.equal(m().lastReceiptBlock.get(GATOR), 140);
      chain.state.pinnedTags.length = 0;
      // The next call reaches a node whose head is still 100.
      await m().executeGatorCall({ accountId: ACCOUNT, provider: chain.provider, chainId: 91342, target: TARGET, value: 0n, data: '0x' });
      assert.ok(chain.state.pinnedTags.length >= 4);
      assert.ok(chain.state.pinnedTags.every((t) => t >= 140), JSON.stringify(chain.state.pinnedTags));
    });

    it('retries a lagging node until it has the block', async () => {
      const chain = makeChain({ lagReads: 2 });
      await run(m(), chain);
      assert.equal(chain.state.broadcasts.length, 1);
    });

    it('reproduces the stale-nonce failure and recovers: AA25 is retried once', async () => {
      const chain = makeChain({
        outer: (_tx, st) => {
          if (st.outerCalls === 1) {
            throw Object.assign(new Error('execution reverted'), {
              code: 'CALL_EXCEPTION',
              data: EPI.encodeErrorResult('FailedOp', [0n, 'AA25 invalid account nonce']),
            });
          }
          return 400_000n;
        },
      });
      await run(m(), chain);
      assert.equal(chain.state.outerCalls, 2);
      assert.equal(chain.state.broadcasts.length, 1);
    });

    it('any other EntryPoint refusal is not retried and nothing is sent', async () => {
      const chain = makeChain({
        outer: () => {
          throw Object.assign(new Error('execution reverted'), {
            code: 'CALL_EXCEPTION',
            data: EPI.encodeErrorResult('FailedOp', [0n, 'AA21 didn\'t pay prefund']),
          });
        },
      });
      await assert.rejects(run(m(), chain), (e) => e.code === 'HANDLEOPS_REJECTED' && e.reason === 'AA21 didn\'t pay prefund' && e.submitted === false);
      assert.equal(chain.state.outerCalls, 1);
      assert.equal(chain.state.broadcasts.length, 0);
    });
  });
}

describe('readAtLeast', () => {
  const provider = (head) => ({ getBlockNumber: async () => head });

  it('reads at latest when there is no floor and no head', async () => {
    const tags = [];
    await bot.readAtLeast(provider(0), null, async (t) => tags.push(t));
    assert.deepEqual(tags, ['latest']);
  });

  it('pins to max(head, floor)', async () => {
    const tags = [];
    await bot.readAtLeast(provider(90), 120, async (t) => tags.push(t));
    await bot.readAtLeast(provider(150), 120, async (t) => tags.push(t));
    assert.deepEqual(tags, [120, 150]);
  });

  it('gives up after a bounded number of attempts', async () => {
    let n = 0;
    const t0 = Date.now();
    await assert.rejects(
      bot.readAtLeast(provider(1), 5, async () => {
        n += 1;
        throw missingBlock();
      }, { attempts: 3, delayMs: 10 }),
      /header not found/
    );
    assert.equal(n, 3);
    assert.ok(Date.now() - t0 < 1000);
  });

  it('does not retry an error that is not a missing block', async () => {
    let n = 0;
    await assert.rejects(bot.readAtLeast(provider(1), 5, async () => { n += 1; throw new Error('boom'); }), /boom/);
    assert.equal(n, 1);
  });

  it('web agrees', async () => {
    const tags = [];
    await web.readAtLeast(provider(90), 120, async (t) => tags.push(t));
    assert.deepEqual(tags, [120]);
  });
});

for (const [side] of [['bot'], ['web']]) {
  const m = () => (side === 'bot' ? bot : web);

  describe(`${side}: a broadcast the node refuses is settled now as not sent`, () => {
    const rejections = {
      'nonce too low': () => Object.assign(new Error('nonce has already been used'), { code: 'NONCE_EXPIRED' }),
      'insufficient funds': () => Object.assign(new Error('insufficient funds for intrinsic transaction cost'), { code: 'INSUFFICIENT_FUNDS' }),
      'invalid transaction (raw node answer)': () =>
        Object.assign(new Error('could not coalesce error'), { code: 'UNKNOWN_ERROR', error: { code: -32000, message: 'invalid transaction: exceeds block gas limit' } }),
    };
    for (const [label, make] of Object.entries(rejections)) {
      it(label, async () => {
        const chain = makeChain({ broadcast: () => { throw make(); } });
        await assert.rejects(run(m(), chain), (e) => {
          assert.equal(e.code, 'BROADCAST_REJECTED');
          assert.equal(e.submitted, false);
          assert.equal(m().outcomeUnknown(e), false);
          assert.match(e.txHash, /^0x[0-9a-f]{64}$/);
          assert.equal(m().gatorErrorCopy(e), 'The network refused this, so nothing was sent. Try again shortly.');
          return true;
        });
      });
    }
  });

  describe(`${side}: no answer from the node is still unknown`, () => {
    const noAnswer = {
      timeout: () => Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }),
      'HTTP error': () => Object.assign(new Error('server response 502 Bad Gateway'), { code: 'SERVER_ERROR' }),
      'network failure': () => Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' }),
      'error with no node answer': () => Object.assign(new Error('could not coalesce error'), { code: 'UNKNOWN_ERROR' }),
    };
    for (const [label, make] of Object.entries(noAnswer)) {
      it(label, async () => {
        const chain = makeChain({ broadcast: () => { throw make(); } });
        await assert.rejects(run(m(), chain), (e) => e.code === 'OUTCOME_UNKNOWN' && e.submitted === true && Boolean(e.txHash));
      });
    }
  });

  describe(`${side}: "already known" means it was sent`, () => {
    it('waits for the receipt and succeeds', async () => {
      const chain = makeChain({
        broadcast: () => {
          throw Object.assign(new Error('could not coalesce error'), { code: 'UNKNOWN_ERROR', error: { code: -32000, message: 'already known' } });
        },
      });
      const res = await run(m(), chain);
      assert.match(res.txHash, /^0x[0-9a-f]{64}$/);
    });
  });
}

describe('the receipt-block memory is bounded', () => {
  it('drops the oldest gator past the cap, on both sides', async () => {
    for (const m of [bot, web]) {
      m.lastReceiptBlock.clear();
      const chain = makeChain({ receipt: (hash) => receiptFor(hash, true, 500) });
      await m.executeGatorCall({ accountId: ACCOUNT, provider: chain.provider, chainId: 91342, target: TARGET, value: 0n, data: '0x' });
      assert.equal(m.lastReceiptBlock.get(GATOR), 500);
      for (let i = 0; i < 10_000; i += 1) m.lastReceiptBlock.set(`0x${i}`, 1);
      // The next receipt for the gator re-inserts it as newest and evicts the oldest.
      const again = makeChain({ receipt: (hash) => receiptFor(hash, true, 600) });
      await m.executeGatorCall({ accountId: ACCOUNT, provider: again.provider, chainId: 91342, target: TARGET, value: 0n, data: '0x' });
      assert.ok(m.lastReceiptBlock.size <= 10_000);
      assert.equal(m.lastReceiptBlock.get(GATOR), 600);
      m.lastReceiptBlock.clear();
    }
  });
});
