/**
 * "flizy send giwaforge to you@email.com" -- a send named by ticker only.
 *
 * The user names an asset and a person, nothing else. Flizy reads the wallet
 * and asks for whatever is still missing:
 *   - holds the token AND the collection -> which one?
 *   - holds several NFTs                 -> which token id?
 *   - holds exactly one NFT              -> straight to the confirm preview
 *   - holds the token only               -> how much?
 *   - holds neither                      -> say so, ask nothing
 *
 * The id list is the part that used to break. It came from an unbounded
 * Transfer-log scan, which the GIWA Sepolia RPC rejects
 * (-32602 query exceeds max block range 100000, chain is past 34M blocks), so
 * every holder read as "balance 1, ids []" and the pick could never be offered.
 * scanOwnedTokenIds reads ownerOf instead; the first describe block pins that.
 *
 * Run: node --test test/sendNamedAsset.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

const SENDER_WA = '2348011110000';
const SENDER_WALLET = '0x1111111111111111111111111111111111111111';
const RECIPIENT_EMAIL = 'friend@example.com';
const COLLECTION = '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A';

let fake = createFakeSupabase();
mockSupabaseModule({ from: (table) => fake.client.from(table) });

// lib/runtime opens a real RPC provider and demands real env; stub it.
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
    supabase: {
      from: (table) => fake.client.from(table),
      rpc: (name, args) => fake.client.rpc(name, args),
    },
    provider: {
      getBalance: async () => ethers.parseEther('5'),
      // Enough ERC-20 to price a listed-token send: the token branch reads
      // balanceOf and decimals before it will draw a preview.
      call: async ({ data }) => {
        const selector = String(data || '').slice(0, 10);
        const abi = ethers.AbiCoder.defaultAbiCoder();
        if (selector === ethers.id('decimals()').slice(0, 10)) {
          return abi.encode(['uint8'], [18]);
        }
        if (selector === ethers.id('balanceOf(address)').slice(0, 10)) {
          return abi.encode(['uint256'], [ethers.parseUnits('1000', 18)]);
        }
        throw new Error(`unstubbed eth_call ${selector}`);
      },
    },
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

// What the wallet holds. Set per test; the router asks this and nothing else.
let holdingsAnswer = { ticker: 'giwaforge', token: null, nft: null };
const holdingsPath = require.resolve('../lib/holdings');
const realHoldings = require('../lib/holdings');
require.cache[holdingsPath].exports = {
  ...realHoldings,
  lookupNamedAssetHoldings: async (wallet, ticker, chain) => {
    lookupCalls.push({ wallet, ticker, chainId: chain && chain.id });
    return holdingsAnswer;
  },
};
const lookupCalls = [];

// Ownership is re-checked on chain at confirm time; keep that seam visible.
let ownedTokenIds = new Set();
const listedNftsPath = require.resolve('../lib/listedNfts');
const realListedNfts = require('../lib/listedNfts');
require.cache[listedNftsPath].exports = {
  ...realListedNfts,
  nftOwnedBy: async (_provider, _collection, tokenId) => ownedTokenIds.has(String(tokenId)),
};

const claimHoldCalls = [];
const executeClaimPath = require.resolve('../lib/engine/executeClaim');
const realExecuteClaim = require('../lib/engine/executeClaim');
require.cache[executeClaimPath].exports = {
  ...realExecuteClaim,
  executeClaimHold: async (args) => {
    claimHoldCalls.push(args);
    return { ok: true, claimUrl: 'https://flizy.test/claim/tok_1', txHash: '0xdead' };
  },
};

const router = require('../lib/router');
const { scanOwnedTokenIds } = realHoldings;
const { parseSendNamedAssetCommand } = router;
const { canonicalizeCommand } = require('../lib/commandAliases');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seed() {
  fake.db.tables.accounts = [
    {
      id: 'acc-sender',
      email: 'sender@flizy.test',
      display_name: 'Sender',
      agent_wallet_address: SENDER_WALLET,
      balance_eth: 5,
      is_admin: false,
      unlock_pin_hash: null,
      daily_send_limit_eth: null,
    },
  ];
  fake.db.tables.channel_identities = [
    {
      id: 'id-sender',
      account_id: 'acc-sender',
      channel: 'whatsapp',
      external_id: SENDER_WA,
      phone_e164: SENDER_WA,
    },
  ];
  fake.db.tables.users = [
    {
      id: 'user-sender',
      phone: SENDER_WA,
      account_id: 'acc-sender',
      balance_eth: 5,
      is_admin: false,
      wallet_address: SENDER_WALLET,
    },
  ];
}

function senderCtx(sent) {
  return {
    channel: 'whatsapp',
    externalId: SENDER_WA,
    key: `whatsapp:${SENDER_WA}`,
    raw: {},
    reply: async (text, opts) => {
      sent.push({ text: String(text), buttons: (opts && opts.buttons) || null });
    },
    resolveVerifiedPhone: async () => SENDER_WA,
  };
}

/** Say each line to the bot in turn; return every reply, in order. */
async function say(...messages) {
  const sent = [];
  const ctx = senderCtx(sent);
  for (const m of messages) await router.handle(ctx, m);
  return sent;
}

const textOf = (sent) => sent.map((s) => s.text);
const lastText = (sent) => (sent.length ? sent[sent.length - 1].text : '');

function nft(ids) {
  return { ticker: 'giwaforge', ids: ids.map(String), balance: String(ids.length) };
}

beforeEach(() => {
  fake = createFakeSupabase();
  mockSupabaseModule({ from: (table) => fake.client.from(table) });
  holdingsAnswer = { ticker: 'giwaforge', token: null, nft: null };
  ownedTokenIds = new Set(['1', '2', '3', '1120', '1124', '1136']);
  lookupCalls.length = 0;
  claimHoldCalls.length = 0;
  // Not pruneExpiredPending: nothing has aged out inside one run, and a pick
  // left open by the previous test would answer this one's first question.
  router.discardPendingFlows(`whatsapp:${SENDER_WA}`);
  seed();
});

// ---------------------------------------------------------------------------
// Token id discovery
// ---------------------------------------------------------------------------

describe('scanOwnedTokenIds', () => {
  /** Minimal ERC-721 view surface: ownerOf reverts on an unminted id. */
  function collection(ownerById, supply) {
    const calls = { ownerOf: 0 };
    return {
      calls,
      totalSupply: async () => BigInt(supply),
      ownerOf: async (id) => {
        calls.ownerOf += 1;
        const who = ownerById[String(id)];
        if (!who) throw new Error('ERC721: invalid token ID');
        return who;
      },
    };
  }

  it('finds the ids a wallet owns without reading a single log', async () => {
    const c = collection({ 1: SENDER_WALLET, 2: '0xbb', 3: SENDER_WALLET }, 3);
    assert.deepEqual(await scanOwnedTokenIds(c, SENDER_WALLET, 2), ['1', '3']);
  });

  it('matches the owner case-insensitively', async () => {
    const c = collection({ 1: SENDER_WALLET.toUpperCase() }, 1);
    assert.deepEqual(await scanOwnedTokenIds(c, SENDER_WALLET.toLowerCase(), 1), ['1']);
  });

  it('covers a 0-indexed collection as well as a 1-indexed one', async () => {
    const c = collection({ 0: SENDER_WALLET, 1: '0xbb' }, 2);
    assert.deepEqual(await scanOwnedTokenIds(c, SENDER_WALLET, 1), ['0']);
  });

  it('treats an unminted id as a miss, not a failure', async () => {
    const c = collection({ 2: SENDER_WALLET }, 5);
    assert.deepEqual(await scanOwnedTokenIds(c, SENDER_WALLET, 1), ['2']);
  });

  it('stops as soon as it has the whole balance', async () => {
    const owners = {};
    for (let i = 1; i <= 400; i += 1) owners[i] = i === 1 ? SENDER_WALLET : '0xbb';
    const c = collection(owners, 400);
    assert.deepEqual(await scanOwnedTokenIds(c, SENDER_WALLET, 1), ['1']);
    assert.ok(
      c.calls.ownerOf <= 101,
      `should stop after the first batch, made ${c.calls.ownerOf} calls`
    );
  });

  it('never probes past the scan ceiling, whatever totalSupply claims', async () => {
    const c = collection({}, 10_000_000);
    assert.deepEqual(await scanOwnedTokenIds(c, SENDER_WALLET, 1), []);
    assert.ok(c.calls.ownerOf <= 601, `probed ${c.calls.ownerOf} ids, expected a ceiling`);
  });

  it('degrades to no ids when the collection cannot be read', async () => {
    const c = {
      totalSupply: async () => {
        throw new Error('rpc down');
      },
      ownerOf: async () => SENDER_WALLET,
    };
    assert.deepEqual(await scanOwnedTokenIds(c, SENDER_WALLET, 1), []);
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseSendNamedAssetCommand', () => {
  it('reads ticker and email destination', () => {
    const p = parseSendNamedAssetCommand(`send giwaforge to ${RECIPIENT_EMAIL}`);
    assert.equal(p.ticker, 'giwaforge');
    assert.equal(p.isEmail, true);
    assert.equal(p.toRaw, RECIPIENT_EMAIL);
    assert.equal(p.nftOnly, false);
  });

  it('keeps the platform destination shapes parseSendCommand already knows', () => {
    const tg = parseSendNamedAssetCommand('send giwaforge to @bob on telegram');
    assert.equal(tg.platform, 'telegram');
    assert.equal(tg.toRaw, 'bob');

    const addr = parseSendNamedAssetCommand(`send giwaforge to ${SENDER_WALLET}`);
    assert.equal(addr.isAddress, true);

    const phone = parseSendNamedAssetCommand('send giwaforge to 2348022220000');
    assert.equal(phone.isPhone, true);
  });

  it('marks "nft send" as NFT-only so a same-named token is skipped', () => {
    assert.equal(parseSendNamedAssetCommand('nft send giwaforge to a@b.com').nftOnly, true);
  });

  it('never takes an amount send, which stays parseSendCommand"s job', () => {
    assert.equal(parseSendNamedAssetCommand('send 0.01 to a@b.com'), null);
    assert.equal(parseSendNamedAssetCommand('send 10 FLZ to john'), null);
  });

  it('needs a destination', () => {
    assert.equal(parseSendNamedAssetCommand('send giwaforge'), null);
    assert.equal(parseSendNamedAssetCommand('send giwaforge to'), null);
  });
});

describe('the alias layer leaves a ticker send alone', () => {
  it('passes the destination through byte for byte', () => {
    assert.equal(
      canonicalizeCommand(`send giwaforge to ${RECIPIENT_EMAIL}`),
      `send giwaforge to ${RECIPIENT_EMAIL}`
    );
    assert.equal(
      canonicalizeCommand('transfer giwaforge to @bob on telegram'),
      'send giwaforge to @bob on telegram'
    );
  });

  it('still routes an amount send the old way', () => {
    assert.equal(canonicalizeCommand('send 0.01 to a@b.com'), 'send 0.01 to a@b.com');
    assert.equal(canonicalizeCommand('pay john 5'), 'send 5 to john');
  });
});

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

describe('send <ticker> to <person>', () => {
  it('reads the wallet on the chain the send will run on', async () => {
    holdingsAnswer = { ticker: 'giwaforge', token: null, nft: nft([2]) };
    await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`);

    assert.equal(lookupCalls.length, 1);
    assert.equal(lookupCalls[0].wallet, SENDER_WALLET);
    assert.equal(lookupCalls[0].ticker, 'giwaforge');
    assert.equal(lookupCalls[0].chainId, 'giwa_sepolia', 'must not fall back to a default chain');
  });

  it('says so and asks nothing when the wallet holds none', async () => {
    holdingsAnswer = { ticker: 'giwaforge', token: null, nft: null };
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`);

    assert.match(lastText(sent), /do not hold giwaforge/i);
    assert.equal(claimHoldCalls.length, 0);
  });

  it('goes straight to the confirm preview when there is only one', async () => {
    holdingsAnswer = { ticker: 'giwaforge', token: null, nft: nft([2]) };
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`);

    const preview = lastText(sent);
    assert.match(preview, /giwaforge #2/, `expected the id in the preview, got: ${preview}`);
    assert.match(preview, /Claim plan/i);
    assert.deepEqual(sent[sent.length - 1].buttons, [
      [
        { label: 'Confirm', value: 'confirm' },
        { label: 'Cancel', value: 'cancel' },
      ],
    ]);
  });

  it('lists the ids to pick from when there are several', async () => {
    holdingsAnswer = { ticker: 'giwaforge', token: null, nft: nft([1120, 1124, 1136]) };
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`);

    const ask = lastText(sent);
    assert.match(ask, /1\. giwaforge 1120/);
    assert.match(ask, /2\. giwaforge 1124/);
    assert.match(ask, /3\. giwaforge 1136/);
    assert.match(ask, /1–3/, 'should say what the valid answers are');
    assert.equal(claimHoldCalls.length, 0, 'nothing moves before the pick');

    // Tappable on Telegram, typeable everywhere.
    assert.deepEqual(sent[sent.length - 1].buttons, [
      [
        { label: '1', value: '1' },
        { label: '2', value: '2' },
        { label: '3', value: '3' },
      ],
      [{ label: 'Cancel', value: 'cancel' }],
    ]);
  });

  it('sends the id the number pointed at', async () => {
    holdingsAnswer = { ticker: 'giwaforge', token: null, nft: nft([1120, 1124, 1136]) };
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`, '2');

    assert.match(lastText(sent), /giwaforge #1124/);
  });

  it('accepts the id itself when it is not also a position', async () => {
    holdingsAnswer = { ticker: 'giwaforge', token: null, nft: nft([1120, 1124, 1136]) };
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`, '1136');

    assert.match(lastText(sent), /giwaforge #1136/);
  });

  it('reads a digit that is both a position and an id as the position', async () => {
    // Ids 1, 2, 3 listed in that order: "2" is unambiguous only because the
    // prompt numbers them. Reading it as the id would be the same answer here;
    // what matters is that one reply never means two things.
    holdingsAnswer = { ticker: 'giwaforge', token: null, nft: nft([3, 1, 2]) };
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`, '2');

    assert.match(lastText(sent), /giwaforge #1/, 'position 2 in the list is id 1');
  });

  it('caps the list and says how to reach an id below the cut', async () => {
    const many = Array.from({ length: 25 }, (_, i) => 1100 + i);
    holdingsAnswer = { ticker: 'giwaforge', token: null, nft: nft(many) };
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`);

    const ask = lastText(sent);
    assert.match(ask, /20\. giwaforge 1119/);
    assert.doesNotMatch(ask, /21\. /);
    assert.match(ask, /Showing 20 of 25/);
    assert.match(ask, /nft send giwaforge <id> to friend@example\.com/);
    assert.equal(sent[sent.length - 1].buttons.length, 5, '4 rows of 5 plus Cancel');
  });

  it('keeps asking when the answer is not a pick', async () => {
    holdingsAnswer = { ticker: 'giwaforge', token: null, nft: nft([1120, 1124]) };
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`, '9');

    assert.match(lastText(sent), /Pick 1–2/);
    assert.equal(claimHoldCalls.length, 0);
  });

  it('cancels cleanly at the pick', async () => {
    holdingsAnswer = { ticker: 'giwaforge', token: null, nft: nft([1120, 1124]) };
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`, 'cancel');

    assert.match(lastText(sent), /Cancelled/i);
    assert.equal(router.pendingFlowFor(`whatsapp:${SENDER_WA}`).choice, false);
  });

  it('will not send an id the wallet no longer owns', async () => {
    // The list is a snapshot. Ownership is re-read on chain at the preview.
    holdingsAnswer = { ticker: 'giwaforge', token: null, nft: nft([1120, 1124]) };
    ownedTokenIds = new Set(['1124']);
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`, '1');

    assert.match(lastText(sent), /do not hold giwaforge #1120/i);
    assert.equal(claimHoldCalls.length, 0);
  });
});

describe('when the ticker is both a token and a collection', () => {
  const both = () => ({
    ticker: 'giwaforge',
    token: { symbol: 'GIWAFORGE', balance: '250.0', native: false },
    nft: nft([1120, 1124]),
  });

  it('asks which one before anything else', async () => {
    holdingsAnswer = both();
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`);

    const ask = lastText(sent);
    assert.match(ask, /token and as NFTs/i);
    assert.match(ask, /1\. giwaforge token \(250\.0\)/);
    assert.match(ask, /2\. giwaforge NFT \(2\)/);
    assert.equal(claimHoldCalls.length, 0);
  });

  it('picking the NFT then asks which id', async () => {
    holdingsAnswer = both();
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`, '2');

    assert.match(lastText(sent), /Which giwaforge do you want to send\?/i);
    assert.match(lastText(sent), /1\. giwaforge 1120/);
  });

  it('picking the token then asks how much, and names the balance', async () => {
    holdingsAnswer = both();
    const sent = await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`, '1');

    assert.match(lastText(sent), /How much giwaforge\?/i);
    assert.match(lastText(sent), /You have 250\.0/);
  });

  it('"nft send" skips the question entirely', async () => {
    holdingsAnswer = both();
    const sent = await say(`flizy nft send giwaforge to ${RECIPIENT_EMAIL}`);

    assert.match(lastText(sent), /Which giwaforge do you want to send\?/i);
    assert.doesNotMatch(textOf(sent).join('\n'), /token and as NFTs/i);
  });
});

describe('a ticker that is only a token', () => {
  beforeEach(() => {
    holdingsAnswer = {
      ticker: 'flz',
      token: { symbol: 'FLZ', balance: '250.0', native: false },
      nft: null,
    };
  });

  it('asks for an amount', async () => {
    const sent = await say(`flizy send flz to ${RECIPIENT_EMAIL}`);
    assert.match(lastText(sent), /How much flz\?/i);
  });

  it('refuses an amount that is not a positive number', async () => {
    const sent = await say(`flizy send flz to ${RECIPIENT_EMAIL}`, 'lots');
    assert.match(lastText(sent), /Reply with an amount/i);
    assert.equal(router.pendingFlowFor(`whatsapp:${SENDER_WA}`).namedSend, true);
  });

  it('carries the amount into the confirm preview', async () => {
    const sent = await say(`flizy send flz to ${RECIPIENT_EMAIL}`, '10');
    const preview = lastText(sent);
    assert.match(preview, /10 FLZ/);
    assert.match(preview, /Claim plan/i);
  });

  it('cancels cleanly at the amount', async () => {
    const sent = await say(`flizy send flz to ${RECIPIENT_EMAIL}`, 'cancel');
    assert.match(lastText(sent), /Cancelled/i);
    assert.equal(router.pendingFlowFor(`whatsapp:${SENDER_WA}`).namedSend, false);
  });
});

describe('a half-finished pick does not leak into the next command', () => {
  it('locking the session discards it', async () => {
    holdingsAnswer = { ticker: 'giwaforge', token: null, nft: nft([1120, 1124]) };
    const key = `whatsapp:${SENDER_WA}`;

    await say(`flizy send giwaforge to ${RECIPIENT_EMAIL}`);
    assert.equal(router.pendingFlowFor(key).choice, true);

    await say('flizy lock');
    assert.equal(router.pendingFlowFor(key).choice, false);
    assert.equal(router.pendingFlowFor(key).namedSend, false);
  });
});

// ---------------------------------------------------------------------------
// The leg that actually moves the NFT
// ---------------------------------------------------------------------------

/**
 * Everything above stops at the confirm preview. This block runs the real
 * executeClaimHold against a stub chain, so the guards that decide whether a
 * giwaforge send proceeds are covered rather than assumed.
 *
 * The broadcast itself is not simulated here -- signing and sending is ethers'
 * job, and faking it proves nothing about the chain. What is pinned is that a
 * hold reaches transferFrom(agent -> escrow, id) only when the agent owns the
 * id and can pay for gas, and refuses with a message the sender can act on
 * otherwise.
 */
describe('holding a giwaforge in escrow', () => {
  const { executeClaimHold } = realExecuteClaim;
  const { deriveAgentWallet } = require('../lib/agentWallet');

  const ESCROW = { address: '0x4444444444444444444444444444444444444444' };
  const CHAIN = {
    id: 'giwa_sepolia',
    name: 'GIWA Sepolia',
    chainId: 91342,
    nativeSymbol: 'ETH',
    explorerBaseUrl: 'https://explorer.test',
  };

  /** Agent wallet for the seeded account, derived exactly as production does. */
  const agentAddress = () => deriveAgentWallet('acc-sender').address;

  /**
   * @param {{ balanceEth?: string, ownerOf?: string|null }} opts
   */
  function chainStub({ balanceEth = '1', ownerOf = agentAddress() } = {}) {
    const sent = [];
    return {
      sent,
      provider: {
        getBalance: async () => ethers.parseEther(balanceEth),
        call: async ({ data }) => {
          const selector = String(data || '').slice(0, 10);
          if (selector === ethers.id('ownerOf(uint256)').slice(0, 10)) {
            if (!ownerOf) throw new Error('ERC721: invalid token ID');
            return ethers.AbiCoder.defaultAbiCoder().encode(['address'], [ownerOf]);
          }
          throw new Error(`unstubbed eth_call ${selector}`);
        },
        getNetwork: async () => new ethers.Network('giwa-sepolia', 91342n),
        getTransactionCount: async () => 0,
        getFeeData: async () =>
          new ethers.FeeData(ethers.parseUnits('1', 'gwei'), null, null),
        // Reached only once both guards pass; records the attempt and stops
        // short of signing, which is ethers' job and not what this pins.
        estimateGas: async (tx) => {
          sent.push(tx);
          throw new Error('broadcast not simulated');
        },
      },
    };
  }

  const hold = (stub, over = {}) =>
    executeClaimHold({
      fromAccountId: 'acc-sender',
      fromWaSender: SENDER_WA,
      recipient: { kind: 'email', email: RECIPIENT_EMAIL },
      amountEth: '1',
      asset: 'GIWAFORGE',
      tokenAddress: COLLECTION,
      nftTokenId: '2',
      provider: stub.provider,
      chain: CHAIN,
      escrowWallet: ESCROW,
      ...over,
    });

  it('refuses when the agent wallet cannot cover gas, and says which to fund', async () => {
    // The live wallet holding giwaforge #2 sits just under this today.
    const stub = chainStub({ balanceEth: '0.00007' });
    const res = await hold(stub);

    assert.equal(res.ok, false);
    assert.match(res.error, /ETH in your agent wallet for gas/i);
    assert.match(res.error, new RegExp(agentAddress()), 'must name the wallet to fund');
    assert.equal(stub.sent.length, 0, 'nothing should be broadcast');
  });

  it('refuses an id the agent does not own', async () => {
    const stub = chainStub({ ownerOf: '0x63A3388846Dad588b80EA114399C3cc15A642fcb' });
    const res = await hold(stub);

    assert.equal(res.ok, false);
    assert.match(res.error, /do not hold giwaforge #2/i);
    assert.equal(stub.sent.length, 0);
  });

  it('refuses an id that was never minted', async () => {
    const stub = chainStub({ ownerOf: null });
    const res = await hold(stub);

    assert.equal(res.ok, false);
    assert.match(res.error, /giwaforge #2 does not exist/i);
    assert.equal(stub.sent.length, 0);
  });

  it('refuses a collection it cannot resolve to an address', async () => {
    const stub = chainStub();
    const res = await hold(stub, { tokenAddress: null });

    assert.equal(res.ok, false);
    assert.match(res.error, /Unknown collection/i);
  });

  it('otherwise moves that exact id from the agent to escrow', async () => {
    const stub = chainStub();
    await hold(stub);

    assert.equal(stub.sent.length, 1, 'should have reached the transfer');
    const tx = stub.sent[0];
    assert.equal(ethers.getAddress(tx.to), ethers.getAddress(COLLECTION));
    assert.equal(ethers.getAddress(tx.from), ethers.getAddress(agentAddress()));

    const iface = new ethers.Interface([
      'function transferFrom(address from, address to, uint256 tokenId)',
    ]);
    const call = iface.parseTransaction({ data: tx.data });
    assert.equal(call.name, 'transferFrom');
    assert.equal(ethers.getAddress(call.args[0]), ethers.getAddress(agentAddress()));
    assert.equal(ethers.getAddress(call.args[1]), ethers.getAddress(ESCROW.address));
    assert.equal(call.args[2], 2n, 'the id the sender picked, not a re-derived one');
  });
});
