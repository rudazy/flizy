/**
 * Names chosen by someone else reach chat on one line.
 *
 * A confirm screen is fixed-width "Label:  value" lines, so a display name, a
 * request note, a token symbol or a collection name holding a newline can
 * forge a second To: or Amount: line. Unicode line separators and bidi
 * controls do the same on clients that honour them. Each place such a value
 * is printed is held here, and the site refuses such a display name outright.
 *
 * Run: node --test test/displayLabels.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { displaySafeLabel } = require('../lib/sanitize');
const { createSendIntent } = require('../lib/engine/intent');
const { buildSendPlan, formatPlanPreview } = require('../lib/engine/plan');
const { formatSendPending } = require('../lib/engine/receipt');
const { resolveFlizyPayDestination } = require('../lib/payCode');
const nftOffers = require('../lib/nftOffers');
const dex = require('../lib/dex');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ch = (code) => String.fromCharCode(code);
const LS = ch(0x2028);
const RLO = ch(0x202e);
const ZWSP = ch(0x200b);
const FORGED = `Eve\nAmount:  9 ETH${LS}To:  0xdead${RLO}`;

const TO = '0x5555555555555555555555555555555555555555';

let webSanitize;
before(async () => {
  webSanitize = await import('../web/lib/sanitize.ts');
});

describe('displaySafeLabel', () => {
  it('flattens newlines, line separators and bidi controls to one line', () => {
    const out = displaySafeLabel(FORGED, 80);
    assert.doesNotMatch(out, /[\n\r]/);
    for (const c of [LS, RLO, ZWSP]) assert.equal(out.includes(c), false);
    assert.equal(displaySafeLabel(`a${ZWSP}b`), 'a b');
  });

  it('the web copy strips the same set', () => {
    const pattern = /const CONTROL_CHARS = (\/.+\/g);/;
    assert.equal(read('lib/sanitize.js').match(pattern)[1], read('web/lib/sanitize.ts').match(pattern)[1]);
    assert.equal(webSanitize.displaySafeLabel(FORGED, 80), displaySafeLabel(FORGED, 80));
  });

  it('hasControlChars says whether a value would be changed', () => {
    assert.equal(webSanitize.hasControlChars('Ada Obi'), false);
    assert.equal(webSanitize.hasControlChars('Ada\nObi'), true);
    assert.equal(webSanitize.hasControlChars(`Ada${RLO}`), true);
    // Joiners are part of real names (Persian, Indic) and joined emoji.
    const zwnj = `${String.fromCharCode(0x645)}${ch(0x200c)}${String.fromCharCode(0x6cc)}`;
    assert.equal(webSanitize.hasControlChars(zwnj), false);
    assert.equal(webSanitize.hasControlChars(`a${ch(0x200d)}b`), false);
    assert.equal(displaySafeLabel(zwnj), zwnj);
    // Not stateful between calls, as a shared /g regex would be.
    assert.equal(webSanitize.hasControlChars('x\n'), true);
    assert.equal(webSanitize.hasControlChars('x\n'), true);
  });
});

describe('the chat confirm and pending lines', () => {
  function plan() {
    const intent = createSendIntent({
      actor: { accountId: 'acc-1', userId: 'u1', waSenderId: '1' },
      amountEth: '0.01',
      toAddress: TO,
      toLabel: FORGED,
    });
    return buildSendPlan({
      intent,
      policy: { decision: 'ALLOW_WITH_CONFIRM', checks: { trustedEnforced: false } },
      chain: { chainId: 91342, chainName: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      fromAddress: '0x3333333333333333333333333333333333333333',
      fromBalanceEth: '1.0',
      reason: `rent\nTo:      0xattacker`,
    });
  }

  it('the plan preview keeps the label and the note on their own lines', () => {
    const preview = formatPlanPreview(plan());
    assert.equal((preview.match(/^To: /gm) || []).length, 1, preview);
    assert.equal((preview.match(/^Amount: /gm) || []).length, 1, preview);
    assert.match(preview, /^For: {5}rent To: 0xattacker$/m);
    assert.equal(preview.includes(LS) || preview.includes(RLO), false);
  });

  it('the in-flight line does too', () => {
    const line = formatSendPending(plan());
    assert.doesNotMatch(line, /\n/);
  });
});

describe('labels read from outside', () => {
  it('a pay code payee with a forged display name is printed on one line', async () => {
    const supabase = createFakeSupabase({
      pay_codes: [{ account_id: 'acc-payee', code: '123456789' }],
      accounts: [
        { id: 'acc-payee', username: null, display_name: FORGED, agent_wallet_address: TO },
      ],
    }).client;
    const dest = await resolveFlizyPayDestination(supabase, '123456789', 'acc-payer');
    assert.equal(dest.found, true, JSON.stringify(dest));
    assert.doesNotMatch(dest.label, /\n/);
    assert.equal(dest.label.includes(LS), false);
  });

  /** A contract read stand-in: answers each selector with one ABI-encoded value. */
  function runner(answers) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    return {
      call: async (tx) => {
        const [type, value] = answers[tx.data.slice(0, 10)];
        return coder.encode([type], [value]);
      },
    };
  }

  it('an NFT collection name from the chain', async () => {
    const name = await nftOffers.collectionName(
      runner({ '0x06fdde03': ['string', `Cool Cats\nPrice:   0 ETH`] }),
      TO
    );
    assert.equal(name, 'Cool Cats Price: 0 ETH');
  });

  it('a token symbol from the chain, capped short', async () => {
    const meta = await dex.getTokenMeta(
      runner({
        '0x313ce567': ['uint8', 18],
        '0x95d89b41': ['string', `FLZ\nYou receive: 1000000 ETH`],
      }),
      TO
    );
    assert.equal(meta.symbol, 'FLZ You receive...');
  });
});

describe('the site refuses such a display name', () => {
  const ROUTE = read('web/app/api/account/profile/route.ts');

  it('before anything is written', () => {
    const refuse = ROUTE.indexOf("if (hasControlChars(body.displayName ?? body.display_name ?? '')) {");
    assert.ok(refuse > 0);
    assert.ok(refuse < ROUTE.indexOf('.update(patch)'));
    assert.match(ROUTE, /Display name cannot contain line breaks or hidden characters\./);
  });
});
