/**
 * Rehearsal of S1 to S8 with a local throwaway key standing in for the Privy
 * wallet, on its own gator and its own state file (state.rehearsal.json).
 * It proves the Node side (digests, caveats, UserOps, batch exit) before a
 * human spends time in the browser. It is not evidence about Privy: the
 * real run is the page plus server.cjs, recorded in RESULTS.md.
 *
 * At the end the stand-in sweeps what is left back to the funder.
 *
 * Run: node spikes/privy-owner/server/rehearse.cjs
 */

const path = require('path');

process.env.SPIKE_STATE_FILE = path.join(__dirname, '..', 'state.rehearsal.json');

const { ethers } = require('ethers');
const dotenv = require('dotenv');
const C = require('./chain.cjs');
const steps = require('./steps.cjs');

const ENV_FILE = path.join(C.SPIKE_DIR, '.env.spike');

function standIn(prov) {
  dotenv.config({ path: ENV_FILE, override: true, quiet: true });
  if (!process.env.SPIKE_REHEARSAL_KEY) {
    steps.appendEnvLine('SPIKE_REHEARSAL_KEY', ethers.Wallet.createRandom().privateKey);
    dotenv.config({ path: ENV_FILE, override: true, quiet: true });
  }
  return new ethers.Wallet(process.env.SPIKE_REHEARSAL_KEY, prov);
}

/** Sign a typedDataJson payload the way eth_signTypedData_v4 does. */
function signTyped(wallet, td) {
  const { EIP712Domain, ...types } = td.types;
  return wallet.signTypedData(td.domain, types, td.message);
}

function show(step, r) {
  console.log(`${step} ${r.status}`);
  if (r.status !== 'PASS') {
    console.log(JSON.stringify(r, null, 2));
    process.exit(1);
  }
}

async function main() {
  const prov = C.provider();
  const me = standIn(prov);

  if (!steps.loadState().steps.S1) {
    const ch = steps.s1Challenge();
    show('S1', steps.s1Verify({
      address: me.address,
      messageSig: await me.signMessage(ch.message),
      typedSig: await signTyped(me, ch.typedData),
      walletClientType: 'rehearsal-local-key',
    }));
  }
  if (!steps.loadState().steps.S2) show('S2', await steps.s2Setup());
  if (!steps.loadState().steps.S3) show('S3', await steps.s3Transfer());
  if (!steps.loadState().steps.S4) {
    const p = await steps.s4Payload();
    show('S4', await steps.s4Verify({ ethSig: await signTyped(me, p.eth), flzSig: await signTyped(me, p.flz) }));
  }
  if (!steps.loadState().steps.S5) show('S5', await steps.s5Redeem());
  if (!steps.loadState().steps.S6) {
    const p = await steps.s6Payload();
    show('S6', await steps.s6Submit({ signature: await signTyped(me, p.typedData) }));
  }
  if (!steps.loadState().steps.S7) {
    const p = await steps.s7Payload();
    show('S7', await steps.s7Submit({ signature: await signTyped(me, p.typedData) }));
  }
  if (!steps.loadState().steps.S8) show('S8', await steps.s8Check());

  await sweep(prov, me);
}

/** Return the rehearsal funds to the funder. */
async function sweep(prov, me) {
  const state = steps.loadState();
  const funder = state.roles.funder;
  const gator = state.gator.address;
  const flz = new ethers.Contract(C.ADDR.flz, C.ERC20_IFACE, prov);

  const gatorFlz = await flz.balanceOf(gator);
  const gatorEth = await prov.getBalance(gator);
  // Keep enough in the gator for the sweep op's own prefund.
  const fee = await prov.getFeeData();
  const reserve = 1_580_000n * ((fee.maxFeePerGas || 2_000_000n) * 2n) * 2n;
  const execs = [];
  if (gatorEth > reserve) execs.push({ target: funder, value: gatorEth - reserve, callData: '0x' });
  if (gatorFlz > 0n) execs.push({ target: C.ADDR.flz, value: 0n, callData: C.ERC20_IFACE.encodeFunctionData('transfer', [funder, gatorFlz]) });
  if (execs.length) {
    const callData = C.GATOR_IFACE.encodeFunctionData('execute(bytes32,bytes)', [C.MODE_BATCH, C.encodeBatch(execs)]);
    const { op } = await C.buildUserOp(prov, gator, callData);
    const td = C.typedDataJson(C.userOpDomain(gator), C.USEROP_TYPES, 'PackedUserOperation', C.userOpMessage(op));
    op.signature = await signTyped(me, td);
    const relayer = new ethers.Wallet(process.env.SPIKE_FUNDER_KEY, prov);
    const sent = await C.submitUserOp(relayer, op);
    console.log(`sweep gator ${sent.success ? 'ok' : 'failed'} ${sent.tx}`);
  }

  const myFlz = await flz.balanceOf(me.address);
  if (myFlz > 0n) await (await flz.connect(me).transfer(funder, myFlz)).wait();
  const myEth = await prov.getBalance(me.address);
  const gasPrice = (fee.maxFeePerGas || 2_000_000n) * 3n;
  // OP Stack adds an L1 data fee on top of L2 gas, so keep a flat margin too.
  const keep = 21_000n * gasPrice + ethers.parseEther('0.0001');
  if (myEth > keep) {
    await (await me.sendTransaction({ to: funder, value: myEth - keep, gasLimit: 21_000n, maxFeePerGas: gasPrice, maxPriorityFeePerGas: fee.maxPriorityFeePerGas || 1_000_000n })).wait();
  }
  console.log('sweep done');
}

main().catch((err) => {
  console.error(`rehearsal error: ${err.shortMessage || err.message}`);
  process.exit(1);
});
