/**
 * Every caller of the smart-account executor, on both sides, is listed here,
 * so a new one fails this test until it is reviewed: does it record the hash at
 * broadcast (onBroadcast), and does it treat an unknown outcome as submitted
 * (never "nothing was sent", never a release or a reopen)?
 *
 * Run: node --test test/executorCallSites.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', '.next', 'generated'].includes(e.name)) walk(rel, out);
    } else if (/\.(js|ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Files that call the executor, and how many times. */
function callers() {
  const found = {};
  for (const f of [...walk('lib'), ...walk('web/lib'), ...walk('web/app')]) {
    if (/gatorExecute\.(js|ts)$/.test(f)) continue;
    const n = (read(f).match(/\bexecute(GatorCall|ApprovalCall)\(\{/g) || []).length;
    if (n) found[f] = n;
  }
  return found;
}

describe('every executor call site is known', () => {
  it('matches the reviewed list (21 call sites)', () => {
    assert.deepEqual(callers(), {
      'lib/ammora/execute.js': 2,
      'lib/dex.js': 2,
      'lib/engine/executeAcceptOffer.js': 1,
      'lib/engine/executeClaim.js': 1,
      'lib/engine/executeTransfer.js': 3,
      'lib/listedNfts.js': 1,
      'web/app/api/pay/execute/route.ts': 2,
      'web/lib/ammora/execute.ts': 2,
      'web/lib/dexServer.ts': 6,
      'web/lib/marketExecute.ts': 1,
    });
  });
});

describe('value-moving calls record their hash before broadcast', () => {
  const expectOnBroadcast = {
    'lib/engine/executeTransfer.js': 3,
    'lib/engine/executeClaim.js': 1,
    'lib/engine/executeSwap.js': 1,
    'lib/engine/executeAcceptOffer.js': 1,
    'lib/dex.js': 1,
    'lib/limitOrders.js': 1,
    'web/app/api/pay/execute/route.ts': 2,
    'web/app/api/swap/execute/route.ts': 1,
    'web/lib/dexServer.ts': 3,
    'web/lib/marketExecute.ts': 1,
    'web/lib/mintExecute.ts': 1,
    'web/app/api/market/[action]/route.ts': 1,
    'lib/ammora/execute.js': 1,
    'lib/ammora/chat.js': 1,
    'web/lib/ammora/execute.ts': 1,
    'web/lib/ammora/siteSwap.ts': 1,
  };
  for (const [file, n] of Object.entries(expectOnBroadcast)) {
    it(file, () => {
      const count = (read(file).match(/onBroadcast[:,]/g) || []).length;
      assert.ok(count >= n, `${file}: ${count} onBroadcast, expected at least ${n}`);
    });
  }

  it('approvals go through executeApprovalCall, which never records', () => {
    assert.match(read('lib/dex.js'), /await executeApprovalCall\(\{/);
    assert.equal((read('web/lib/dexServer.ts').match(/await executeApprovalCall\(\{/g) || []).length, 3);
    assert.match(read('web/lib/marketExecute.ts'), /: await executeApprovalCall\(params\)/);
    // Ammora: every approval step is its own executeApprovalCall, the swap the only executeGatorCall.
    for (const f of ['lib/ammora/execute.js', 'web/lib/ammora/execute.ts']) {
      assert.equal((read(f).match(/executeApprovalCall\(\{/g) || []).length, 1, f);
      assert.equal((read(f).match(/executeGatorCall\(\{/g) || []).length, 1, f);
    }
  });

  it('the listed mint moves no value and records nothing (copy only)', () => {
    const src = read('lib/listedNfts.js');
    assert.doesNotMatch(src, /onBroadcast/);
    assert.match(src, /if \(outcomeUnknown\(err\)\) \{\s*return \{ ok: false, submitted: true, error: gatorErrorCopy\(err\) \};/);
  });
});

describe('an unknown outcome is never marked failed or released', () => {
  const guarded = {
    'lib/engine/executeTransfer.js': /if \(outcomeUnknown\(err\)\) submitted = true;\s*if \(transferRow\?\.id && !submitted\)/g,
    'web/app/api/pay/execute/route.ts': /if \(rowId && !outcomeUnknown\(sendErr\)\)/g,
    'web/app/api/swap/execute/route.ts': /if \(logRow\?\.id && !outcomeUnknown\(swapErr\)\)/g,
    'web/app/api/market/[action]/route.ts': /if \(!outcomeUnknown\(sendErr\)\)/g,
    'web/lib/mintExecute.ts': /if \(!outcomeUnknown\(sendErr\)\)/g,
    'web/lib/ammora/siteSwap.ts': /if \(!outcomeUnknown\(err\)\) \{\s*await supabase\.from\('transfers'\)\.update\(\{ status: 'failed'/g,
    'lib/ammora/chat.js': /if \(outcomeUnknown\(err\)\) return \{ ok: false, submitted: true/g,
  };
  for (const [file, re] of Object.entries(guarded)) {
    it(file, () => assert.ok((read(file).match(re) || []).length >= 1, file));
  }

  it('executeTransfer guards all three paths', () => {
    assert.equal((read('lib/engine/executeTransfer.js').match(/if \(outcomeUnknown\(err\)\) submitted = true;/g) || []).length, 3);
  });

  it('the payment request is released only when nothing was submitted', () => {
    assert.match(read('lib/router.js'), /\} else if \(!result\.submitted\) \{\s*\/\/ Nothing reached the chain[\s\S]{0,200}releaseRequestProcessing\(paymentRequestId\)/);
  });
});

describe('site routes return only fixed copy for executor outcomes', () => {
  let outcome;
  before(async () => {
    process.env.WALLET_DERIVATION_SECRET = process.env.WALLET_DERIVATION_SECRET || 'x'.repeat(40);
    outcome = await import('../web/lib/gatorOutcome.ts');
  });

  for (const file of [
    'web/app/api/pay/execute/route.ts',
    'web/app/api/swap/execute/route.ts',
    'web/app/api/swap/liquidity/route.ts',
    'web/app/api/market/[action]/route.ts',
  ]) {
    it(file, () =>
      assert.match(
        read(file),
        /const executorOutcome = gatorFailure\((err|sendErr)\);\s*if \(executorOutcome\) return NextResponse\.json\(executorOutcome\.body, \{ status: executorOutcome\.status \}\);/
      )
    );
  }

  it('mints map executor outcomes into MintError copy', () => {
    assert.match(read('web/lib/mintExecute.ts'), /const executorOutcome = gatorFailure\(sendErr\);\s*if \(executorOutcome\) throw new MintError\(executorOutcome\.body\.error, executorOutcome\.status, executorOutcome\.body\.code\);/);
  });

  it('unknown is 409 pending with the still-confirming copy; a refusal is 400; anything else is not mapped', async () => {
    const { GatorExecError } = await import('../web/lib/gatorExecute.ts');
    const unknown = outcome.gatorFailure(new GatorExecError('OUTCOME_UNKNOWN', 'raw rpc text 0xdeadbeef', { submitted: true, txHash: '0x' + '1'.repeat(64) }));
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.pending, true);
    assert.match(unknown.body.error, /^Sent, and still confirming/);
    const refused = outcome.gatorFailure(new GatorExecError('WOULD_REVERT', 'execution reverted 0x8199f5f3'));
    assert.deepEqual(refused, { status: 400, body: { error: 'This would fail right now, so nothing was sent.', code: 'WOULD_REVERT' } });
    // The raw messages above never reach the client: only the fixed copy does.
    for (const r of [unknown, refused]) assert.doesNotMatch(r.body.error, /0x|revert|rpc/i);
    assert.equal(outcome.gatorFailure(new Error('boom')), null);
    assert.equal(outcome.gatorFailure(new GatorExecError('USEROP_REVERTED', 'x', { txHash: '0x1' })), null);
  });
});
