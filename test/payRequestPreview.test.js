/**
 * The confirm screen for paying a payment request has to name who is asking.
 *
 * This is the one path in the product where money leaves to an address that is
 * not on the payer's trusted list, and it used to render `To: request
 * (0x1234…abcd)`. Anyone who knows a phone number can raise a request, so the
 * single screen between that and the money named nobody at all.
 *
 * Run: node --test test/payRequestPreview.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

process.env.WALLET_DERIVATION_SECRET =
  process.env.WALLET_DERIVATION_SECRET || 'test-derivation-secret';

let fake = createFakeSupabase();
mockSupabaseModule({ from: (table) => fake.client.from(table) });

// Only the trusted address is on the allowlist, so a requester's wallet is not.
const trustedPath = require.resolve('../lib/trusted');
const TRUSTED = '0x1111111111111111111111111111111111111111';
const REQUESTER_WALLET = '0x2222222222222222222222222222222222222222';
require.cache[trustedPath] = {
  id: trustedPath,
  filename: trustedPath,
  loaded: true,
  exports: {
    isTrustedAddress: async (_accountId, address) =>
      String(address).toLowerCase() === TRUSTED.toLowerCase(),
    rejectUntrustedMessage: () => 'That destination is not allowed.',
    addTrusted: async () => ({}),
    removeTrusted: async () => {},
    listTrusted: async () => [],
  },
};

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
    supabase: { from: (table) => fake.client.from(table) },
    provider: {},
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

const router = require('../lib/router');
const { createSendIntent } = require('../lib/engine/intent');
const { evaluateSendPolicy } = require('../lib/engine/policy');
const { buildSendPlan, formatPlanPreview } = require('../lib/engine/plan');

const PAYER_ACCOUNT = 'acc-payer';
const REQUESTER_ACCOUNT = 'acc-requester';

/** The request row startPayRequest works from. */
function requestRow(over = {}) {
  return {
    id: 'req-1',
    requester_account_id: REQUESTER_ACCOUNT,
    requester_wa: '2348012345678',
    from_wa_hint: '2349000000000',
    amount_eth: '0.02',
    status: 'pending',
    ...over,
  };
}

/**
 * The preview a payer actually reads, built through the same three calls
 * handleSendResolved makes.
 */
async function previewFor(label, { skipTrusted = true } = {}) {
  const intent = createSendIntent({
    actor: {
      accountId: PAYER_ACCOUNT,
      userId: 'user-payer',
      waSenderId: '2349000000000',
      isAdmin: false,
      creditEth: 1,
      sessionUnlocked: true,
      hasPin: false,
    },
    amountEth: '0.02',
    toAddress: REQUESTER_WALLET,
    toLabel: label,
    toIsAddress: true,
    chainId: '91342',
    asset: 'native',
  });

  const policy = await evaluateSendPolicy(intent, {
    enforceTrusted: !skipTrusted,
    accountRow: {},
    nativeSymbol: 'ETH',
  });

  const plan = buildSendPlan({
    intent,
    policy,
    chain: { chainId: 91342, chainName: 'GIWA Sepolia', nativeSymbol: 'ETH' },
    fromAddress: '0x5555555555555555555555555555555555555555',
    fromBalanceEth: '1.0',
  });

  return { policy, plan, text: formatPlanPreview(plan) };
}

describe('a pay-request preview names the requester', () => {
  beforeEach(() => {
    fake = createFakeSupabase({
      accounts: [
        { id: PAYER_ACCOUNT },
        { id: REQUESTER_ACCOUNT, display_name: 'Ada Obi' },
      ],
    });
    require.cache[runtimePath].exports.supabase = { from: (table) => fake.client.from(table) };
  });

  it('uses the display name when the requester has one', async () => {
    const label = await router.requesterLabel(requestRow());
    assert.equal(label, 'Ada Obi');
  });

  it('never renders the literal string "request" as the label', async () => {
    const label = await router.requesterLabel(requestRow());
    assert.notEqual(label, 'request');

    const { text } = await previewFor(label);
    // The old preview line, which named nobody
    assert.ok(!/^To:\s+request\b/m.test(text), text);
    assert.match(text, /^To: {6}Ada Obi \(0x2222\.\.\.2222\)$/m);
  });

  it('falls back to the verified phone when there is no display name', async () => {
    fake.db.tables.accounts.find((a) => a.id === REQUESTER_ACCOUNT).display_name = null;
    const label = await router.requesterLabel(requestRow());
    assert.equal(label, '+2348012345678');

    const { text } = await previewFor(label);
    assert.match(text, /^To: {6}\+2348012345678 \(0x2222\.\.\.2222\)$/m);
  });

  it('says so honestly when there is neither a name nor a phone', async () => {
    fake.db.tables.accounts.find((a) => a.id === REQUESTER_ACCOUNT).display_name = '   ';
    const label = await router.requesterLabel(requestRow({ requester_wa: null }));
    assert.equal(label, 'unknown requester');
    assert.notEqual(label, 'request');
  });

  it('survives a requester account that cannot be read', async () => {
    const label = await router.requesterLabel(
      requestRow({ requester_account_id: 'acc-missing' })
    );
    // Still names the human by the number they verified
    assert.equal(label, '+2348012345678');
  });

  it('matches the shape a trusted-name preview uses', async () => {
    // A trusted send renders "<label> (<short address>)". Reading either screen
    // should feel like reading the same screen.
    const trusted = await previewFor('mum', { skipTrusted: false });
    const request = await previewFor(await router.requesterLabel(requestRow()));

    const shape = /^To: {6}.+ \(0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{4}\)$/m;
    assert.match(trusted.text, shape);
    assert.match(request.text, shape);
  });

  it('cannot be used to forge extra preview lines', async () => {
    // The name belongs to the requester, not the payer, and the preview is
    // newline separated "Label:  value" lines.
    fake.db.tables.accounts.find((a) => a.id === REQUESTER_ACCOUNT).display_name =
      'Ada\nTo:      mum (0x1111…1111)\nAmount:  0.0001 ETH';
    const label = await router.requesterLabel(requestRow());
    assert.ok(!label.includes('\n'), label);

    const { text } = await previewFor(label);
    assert.equal(text.match(/^To:/gm).length, 1);
    assert.equal(text.match(/^Amount:/gm).length, 1);
  });
});

describe('the preview says the recipient is not on the trusted list', () => {
  beforeEach(() => {
    fake = createFakeSupabase({
      accounts: [{ id: PAYER_ACCOUNT }, { id: REQUESTER_ACCOUNT, display_name: 'Ada Obi' }],
    });
    require.cache[runtimePath].exports.supabase = { from: (table) => fake.client.from(table) };
  });

  it('warns when the allowlist was bypassed', async () => {
    const { text } = await previewFor('Ada Obi', { skipTrusted: true });
    assert.match(text, /Not on your trusted list/);
  });

  it('stays quiet on an ordinary trusted send', async () => {
    const { text } = await previewFor('mum', { skipTrusted: false });
    assert.ok(!/Not on your trusted list/.test(text), text);
  });

  it('records that the allowlist was skipped rather than that it passed', async () => {
    // checks.trusted is true either way, which is why the preview needs its own
    // signal to tell "on the list" from "nobody looked".
    const skipped = await previewFor('Ada Obi', { skipTrusted: true });
    assert.equal(skipped.policy.checks.trusted, true);
    assert.equal(skipped.policy.checks.trustedEnforced, false);

    const enforced = await previewFor('mum', { skipTrusted: false });
    assert.equal(enforced.policy.checks.trustedEnforced, true);
  });
});

describe('skipTrusted stays on for pay-request (decided, not incidental)', () => {
  beforeEach(() => {
    fake = createFakeSupabase({
      accounts: [{ id: PAYER_ACCOUNT }, { id: REQUESTER_ACCOUNT, display_name: 'Ada Obi' }],
    });
    require.cache[runtimePath].exports.supabase = { from: (table) => fake.client.from(table) };
  });

  it('allows paying a requester who is not on the allowlist', async () => {
    // The allowlist stops a compromised bot choosing its own destination. It is
    // not there to stop a user paying a named human who asked them, and being
    // asked by somebody you have never paid is the whole feature.
    const { policy } = await previewFor('Ada Obi', { skipTrusted: true });
    assert.equal(policy.decision, 'ALLOW_WITH_CONFIRM');
  });

  it('still denies that same address on an ordinary send', async () => {
    const { policy } = await previewFor('Ada Obi', { skipTrusted: false });
    assert.equal(policy.decision, 'DENY');
    assert.equal(policy.reason, 'untrusted');
  });
});
