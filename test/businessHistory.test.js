/**
 * A business's history (Phase 0e, part 3c): each payment it received shows
 * what arrived and what Flizy kept (lib/history.js attachBusinessFees, the chat
 * history, GET /api/history and the History row).
 *
 * Covers: a received payment with a merchant fee shows what arrived, what Flizy
 * kept and the price, in the asset's own decimals; a pending fee counts, a
 * waived one kept nothing; the payer's own row, a person-to-person payment and
 * a payment with no fee are untouched; a failed read leaves the rows as they
 * were; chat, the site route and the History row use it; and no root file the
 * site loads requires a package, which the site build cannot resolve.
 *
 * Run: node --test test/businessHistory.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const { builtinModules } = require('node:module');
const { attachBusinessFees } = require('../lib/history');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const received = (id, amount, asset = 'ETH') => ({ source: 'transfer', received: true, row: { id, amount_eth: amount, asset } });
const fee = (sourceId, units, over = {}) => ({ source_kind: 'transfer', source_id: sourceId, kind: 'merchant', fee_units: units, asset: 'ETH', state: 'charged', ...over });

describe('what a business received', () => {
  it('what arrived, what Flizy kept, and the price', async () => {
    const store = createFakeSupabase({ fee_ledger: [fee('t1', String(5n * 10n ** 14n)), fee('t2', '100000', { asset: 'TUSD' })] });
    const items = [received('t1', '0.05'), received('t2', '10', 'TUSD')];
    await attachBusinessFees(store.client, items);
    assert.deepEqual(items[0].businessFee, { kept: '0.0005', arrived: '0.0495', gross: '0.05', asset: 'ETH' });
    // tUSD has 6 decimals; whole amounts read without ".0".
    assert.deepEqual(items[1].businessFee, { kept: '0.1', arrived: '9.9', gross: '10', asset: 'TUSD' });
  });

  it('a pending fee counts (the split already happened); a waived one kept nothing', async () => {
    const store = createFakeSupabase({ fee_ledger: [fee('t1', '500', { state: 'pending' }), fee('t2', '500', { state: 'waived' })] });
    const items = [received('t1', '0.05'), received('t2', '0.05')];
    await attachBusinessFees(store.client, items);
    assert.ok(items[0].businessFee);
    assert.equal(items[1].businessFee, undefined);
  });

  it('the payer row, a person-to-person fee, a payment with no fee, and a claim are untouched', async () => {
    const store = createFakeSupabase({ fee_ledger: [fee('t1', '500'), fee('t2', '500', { kind: 'p2p' })] });
    const items = [
      { source: 'transfer', received: false, row: { id: 't1', amount_eth: '0.05', asset: 'ETH' } },
      received('t2', '0.05'),
      received('t3', '0.05'),
      { source: 'claim', row: { id: 't1' } },
    ];
    await attachBusinessFees(store.client, items);
    for (const item of items) assert.equal(item.businessFee, undefined);
  });

  it('a read that fails leaves the rows as they were; nothing to look up reads nothing', async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: null, error: { message: 'down' } }) }) }) }) }) };
    const items = [received('t1', '0.05')];
    const warn = console.warn;
    console.warn = () => {};
    try {
      await attachBusinessFees(broken, items);
    } finally {
      console.warn = warn;
    }
    assert.equal(items[0].businessFee, undefined);
    let asked = false;
    await attachBusinessFees({ from: () => { asked = true; } }, [{ source: 'transfer', received: false, row: { id: 'x' } }]);
    assert.equal(asked, false);
  });
});

describe('where it shows', () => {
  it('the history loader attaches it after naming the senders', () => {
    const src = read('lib/history.js');
    const at = src.indexOf('await attachBusinessFees(supabase, items);');
    assert.ok(at > src.indexOf('await nameSenders(supabase, items);'));
  });

  it('chat history: what arrived, and a line with what Flizy kept', () => {
    const router = read('lib/router.js');
    assert.ok(router.includes('const amt = fee ? fee.arrived : formatEth(row.amount_eth);'));
    assert.ok(router.includes('if (fee) lines.push(`  Flizy kept ${fee.kept} ${asset} (business fee on ${fee.gross} ${asset})`);'));
  });

  it('the site route: what arrived on a received row, with the fee', () => {
    const route = read('web/app/api/history/route.ts');
    assert.match(route, /const amount = received && businessFee \? businessFee\.arrived : \(row\.amount_eth as string \| number\);/);
    assert.match(route, /\.\.\.\(received && businessFee \? \{ businessFee: \{ kept: businessFee\.kept, gross: businessFee\.gross \} \} : \{\}\),/);
    assert.match(route, /mapTransferRow\(entry\.row, Boolean\(entry\.received\), entry\.fromLabel \?\? null, entry\.businessFee\)/);
  });

  it('the History row says what Flizy kept, and so do its details', () => {
    const ui = read('web/components/ActivityPanels.tsx');
    assert.match(ui, /Flizy kept \{row\.businessFee\.kept\} \{row\.asset\} of \{row\.businessFee\.gross\} \{row\.asset\}/);
    assert.match(ui, /<Detail label="Business fee"/);
  });
});

describe('the site build', () => {
  // Vercel builds web/ alone: packages resolve from web/node_modules, so a root
  // lib/ file the site requires must load nothing but other lib/ files and Node.
  it('every root file the site loads requires only relative lib/ files and Node built-ins', () => {
    const root = path.join(__dirname, '..');
    const web = [];
    const walkDir = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkDir(p);
        else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) web.push(p);
      }
    };
    walkDir(path.join(root, 'web', 'app'));
    walkDir(path.join(root, 'web', 'lib'));
    const libDir = path.join(root, 'lib') + path.sep;
    const seeds = new Set();
    for (const file of web) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\('([^']+)'\)/g)) {
        const target = require.resolve(path.resolve(path.dirname(file), m[1]));
        if (target.startsWith(libDir)) seeds.add(target);
      }
    }
    assert.ok(seeds.has(require.resolve('../lib/history')), 'the history route loads lib/history.js');
    const builtins = new Set(builtinModules.flatMap((b) => [b, `node:${b}`]));
    const seen = new Set();
    const queue = [...seeds];
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\('([^']+)'\)/g)) {
        const spec = m[1];
        if (builtins.has(spec)) continue;
        assert.ok(spec.startsWith('.'), `${path.relative(root, file)} requires the package "${spec}", which the site build cannot resolve`);
        queue.push(require.resolve(path.resolve(path.dirname(file), spec)));
      }
    }
  });
});
