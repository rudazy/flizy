/**
 * Headless run of S1 and S3 to S8 on the funded gator in state.json, with a
 * Privy server wallet (owned by a local authorization key) as the Privy
 * owner. Privy only signs; the relayer submits every transaction.
 *
 * Not covered here: the browser login and embedded-wallet signing UI, and S9
 * (guest MetaMask through Privy). RESULTS.md says so.
 *
 * Run: node spikes/privy-owner/server/headless.cjs
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const C = require('./chain.cjs');
const steps = require('./steps.cjs');
const privy = require('./privyApi.cjs');
const { writeResults } = require('./results.cjs');

const ENV_FILE = path.join(C.SPIKE_DIR, '.env.spike');
const STATE_FILE = steps.STATE_FILE;

function loadEnv() {
  dotenv.config({ path: ENV_FILE, override: true, quiet: true });
}

/** Create the authorization key once. Stored in .env.spike, never printed. */
function ensureAuthKey() {
  loadEnv();
  if (process.env.PRIVY_AUTH_KEY) return;
  const { privateKey } = privy.generateAuthKey();
  steps.appendEnvLine('PRIVY_AUTH_KEY', privateKey);
  loadEnv();
}

function saveCoverage() {
  const state = steps.loadState();
  state.coverage = {
    runner: 'headless: Node calls the Privy wallet API; no browser',
    privyWallet: 'Privy server wallet created through POST /v1/wallets, owned by a locally generated P-256 authorization key',
    notCovered: [
      'Browser login (email) and the Privy embedded-wallet signing UI',
      'S9: guest MetaMask wallet connected through Privy doing a self-transfer',
    ],
  };
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function show(step, r) {
  console.log(`${step} ${r.status}`);
  writeResults(steps.loadState());
  if (r.status !== 'PASS') {
    console.log(JSON.stringify(r, null, 2));
    process.exit(1);
  }
}

async function main() {
  ensureAuthKey();
  saveCoverage();

  let state = steps.loadState();
  if (!state.steps.S2 || state.steps.S2.status !== 'PASS') throw new Error('S2 must have passed on this state');

  // The Privy wallet id is an internal API identifier, so it lives in
  // .env.spike with the keys. state.json, which is public, keeps the address.
  if (state.privyApiWallet && state.privyApiWallet.id) {
    if (!process.env.PRIVY_WALLET_ID) steps.appendEnvLine('PRIVY_WALLET_ID', state.privyApiWallet.id);
    delete state.privyApiWallet.id;
    delete state.privyApiWallet.ownerId;
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    loadEnv();
  }
  if (!state.privyApiWallet) {
    const w = await privy.createWallet(privy.publicKeyOf(process.env.PRIVY_AUTH_KEY));
    steps.appendEnvLine('PRIVY_WALLET_ID', w.id);
    loadEnv();
    state = steps.loadState();
    state.privyApiWallet = { address: w.address };
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    console.log(`Privy wallet created: ${w.address}`);
  }
  const walletId = process.env.PRIVY_WALLET_ID;
  if (!walletId) throw new Error('PRIVY_WALLET_ID is missing from .env.spike');
  const wallet = { id: walletId, address: steps.loadState().privyApiWallet.address };
  const signTyped = (td) => privy.signTypedData(wallet.id, td);
  const done = (id) => steps.loadState().steps[id] && steps.loadState().steps[id].status === 'PASS';

  if (!done('S1')) {
    const ch = steps.s1Challenge();
    show('S1', steps.s1Verify({
      address: wallet.address,
      messageSig: await privy.personalSign(wallet.id, ch.message),
      typedSig: await signTyped(ch.typedData),
      walletClientType: 'privy-server-wallet',
    }));
  }
  if (!done('S3')) show('S3', await steps.s3Transfer());
  if (!done('S4')) {
    const p = await steps.s4Payload();
    show('S4', await steps.s4Verify({ ethSig: await signTyped(p.eth), flzSig: await signTyped(p.flz) }));
  }
  if (!done('S5')) show('S5', await steps.s5Redeem());
  if (!done('S6')) {
    const p = await steps.s6Payload();
    show('S6', await steps.s6Submit({ signature: await signTyped(p.typedData) }));
  }
  if (!done('S7')) {
    const p = await steps.s7Payload();
    show('S7', await steps.s7Submit({ signature: await signTyped(p.typedData) }));
  }
  if (!done('S8')) show('S8', await steps.s8Check());
  writeResults(steps.loadState());
}

main().catch((err) => {
  try {
    writeResults(steps.loadState());
  } catch {
    // results are best effort on the error path
  }
  console.error(`headless error: ${err.shortMessage || err.message}`);
  process.exit(1);
});
