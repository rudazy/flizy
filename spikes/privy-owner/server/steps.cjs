/**
 * Steps S1 to S9 of the Privy owner spike.
 *
 * Node holds every throwaway key (funder/relayer, original owner, Flizy
 * stand-in delegate). The browser only ever receives typed data to sign and
 * returns a signature. State is public data only (addresses, hashes,
 * signatures over testnet delegations) and lives in state.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');
const dotenv = require('dotenv');
const C = require('./chain.cjs');

const ENV_FILE = path.join(C.SPIKE_DIR, '.env.spike');
// SPIKE_STATE_FILE lets the rehearsal (server/rehearse.cjs) keep its own state.
const STATE_FILE = process.env.SPIKE_STATE_FILE || path.join(C.SPIKE_DIR, 'state.json');

/** Amounts. Small, testnet only. */
const AMT = {
  gatorEth: ethers.parseEther('0.02'),
  gatorFlz: ethers.parseEther('20'),
  delegateEth: ethers.parseEther('0.003'),
  ethCap: ethers.parseEther('0.005'),
  ethIn: ethers.parseEther('0.001'),
  ethOut: ethers.parseEther('0.01'),
  flzCap: ethers.parseEther('10'),
  flzIn: ethers.parseEther('1'),
  flzOut: ethers.parseEther('20'),
  exitEth: ethers.parseEther('0.01'),
  exitFlz: ethers.parseEther('5'),
};

// ---------------------------------------------------------------------------
// State and keys
// ---------------------------------------------------------------------------

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { steps: {} };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function record(state, step, status, evidence) {
  state.steps[step] = { status, at: new Date().toISOString(), ...evidence };
  saveState(state);
  return state.steps[step];
}

/** Append NAME=value on its own line, even when the file lacks a trailing newline. */
function appendEnvLine(name, value) {
  const current = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(ENV_FILE, `${sep}${name}=${value}\n`);
}

function loadKeys() {
  dotenv.config({ path: ENV_FILE, override: true, quiet: true });
}

/** Generate a throwaway key once and append it to .env.spike. Never printed. */
function ensureKey(name) {
  loadKeys();
  if (process.env[name]) return;
  appendEnvLine(name, ethers.Wallet.createRandom().privateKey);
  loadKeys();
}

function wallets(prov) {
  for (const k of ['SPIKE_FUNDER_KEY', 'SPIKE_OWNER_KEY', 'SPIKE_DELEGATE_KEY']) ensureKey(k);
  return {
    funder: new ethers.Wallet(process.env.SPIKE_FUNDER_KEY, prov),
    owner: new ethers.Wallet(process.env.SPIKE_OWNER_KEY, prov),
    delegate: new ethers.Wallet(process.env.SPIKE_DELEGATE_KEY, prov),
  };
}

function requireSig(sig, label) {
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    throw new Error(`${label}: expected a 65-byte hex signature`);
  }
  return sig;
}

function requireAddress(value, label) {
  if (typeof value !== 'string' || !ethers.isAddress(value)) throw new Error(`${label}: not an address`);
  return ethers.getAddress(value);
}

function requireStep(state, step) {
  if (!state.steps[step] || state.steps[step].status !== 'PASS') throw new Error(`${step} has not passed yet`);
}

async function snapshot(prov, state, label) {
  const gator = state.gator.address;
  const gatorC = new ethers.Contract(gator, C.GATOR_IFACE, prov);
  const snap = {
    label,
    address: gator,
    codeKeccak: await C.codeKeccak(prov, gator),
    owner: await gatorC.owner(),
    block: await prov.getBlockNumber(),
  };
  state.snapshots = state.snapshots || [];
  state.snapshots.push(snap);
  saveState(state);
  return snap;
}

/**
 * Balances at a pinned block. The public RPC is load balanced, so two "latest"
 * reads can land on different heads; a delta must name its blocks.
 */
async function balances(prov, addrs, blockTag = 'latest') {
  const flz = new ethers.Contract(C.ADDR.flz, C.ERC20_IFACE, prov);
  const out = {};
  for (const [name, a] of Object.entries(addrs)) {
    out[name] = { eth: await prov.getBalance(a, blockTag), flz: await flz.balanceOf(a, { blockTag }) };
  }
  return out;
}

/** Per-address ETH and FLZ change across one mined block. */
async function deltaAcross(prov, watch, blockNumber) {
  const before = await balances(prov, watch, blockNumber - 1);
  const after = await balances(prov, watch, blockNumber);
  const delta = {};
  for (const k of Object.keys(watch)) {
    delta[k] = { eth: s(after[k].eth - before[k].eth), flz: s(after[k].flz - before[k].flz) };
  }
  return delta;
}

const s = (v) => v.toString();

// ---------------------------------------------------------------------------
// S1: Privy wallet signs a message and an EIP-712 payload
// ---------------------------------------------------------------------------

const S1_DOMAIN = { name: 'Flizy Privy Spike', version: '1', chainId: C.CHAIN_ID };
const S1_TYPES = { Check: [{ name: 'purpose', type: 'string' }, { name: 'nonce', type: 'bytes32' }] };

function s1Challenge() {
  const state = loadState();
  const nonce = ethers.hexlify(crypto.randomBytes(32));
  state.s1Nonce = nonce;
  saveState(state);
  return {
    message: `Flizy Privy owner spike S1. Nonce ${nonce}`,
    typedData: {
      domain: S1_DOMAIN,
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        ...S1_TYPES,
      },
      primaryType: 'Check',
      message: { purpose: 'S1 typed data check', nonce },
    },
  };
}

function s1Verify(body) {
  const state = loadState();
  if (!state.s1Nonce) throw new Error('request the S1 challenge first');
  const address = requireAddress(body.address, 'address');
  const messageSig = requireSig(body.messageSig, 'messageSig');
  const typedSig = requireSig(body.typedSig, 'typedSig');
  const message = `Flizy Privy owner spike S1. Nonce ${state.s1Nonce}`;
  const fromMessage = ethers.verifyMessage(message, messageSig);
  const fromTyped = ethers.verifyTypedData(S1_DOMAIN, S1_TYPES, { purpose: 'S1 typed data check', nonce: state.s1Nonce }, typedSig);
  const ok = fromMessage === address && fromTyped === address;
  delete state.s1Nonce;
  if (ok) state.privy = { address, walletClientType: String(body.walletClientType || '') };
  return record(state, 'S1', ok ? 'PASS' : 'FAIL', { address, recoveredMessage: fromMessage, recoveredTyped: fromTyped, walletClientType: String(body.walletClientType || '') });
}

// ---------------------------------------------------------------------------
// S2: throwaway gator, owned by a throwaway EOA, funded with ETH and FLZ
// ---------------------------------------------------------------------------

async function s2Setup() {
  const prov = C.provider();
  const { funder, owner, delegate } = wallets(prov);
  const state = loadState();
  state.roles = { funder: funder.address, owner: owner.address, delegate: delegate.address };
  state.sink = state.sink || ethers.Wallet.createRandom().address;
  saveState(state);

  // ERC20TransferAmountEnforcer from v1.3.0. Not on GIWA yet, so deploy one copy.
  if (!state.erc20Enforcer) {
    const art = C.artifact('ERC20TransferAmountEnforcer.sol', 'ERC20TransferAmountEnforcer');
    const tx = await funder.sendTransaction({ data: art.bytecode });
    const rcpt = await tx.wait();
    const runtime = await prov.getCode(rcpt.contractAddress);
    state.erc20Enforcer = {
      address: rcpt.contractAddress,
      tx: rcpt.hash,
      runtimeMatchesArtifact: ethers.keccak256(runtime) === ethers.keccak256(art.deployedBytecode),
    };
    saveState(state);
  }

  if (!state.gator) {
    const salt = ethers.keccak256(ethers.toUtf8Bytes(`flizy:spike:privy-owner:${ethers.hexlify(crypto.randomBytes(16))}`));
    const bytecode = C.gatorProxyBytecode(owner.address);
    const predicted = ethers.getCreate2Address(C.ADDR.simpleFactory, salt, ethers.keccak256(bytecode));
    const factory = new ethers.Contract(C.ADDR.simpleFactory, C.FACTORY_IFACE, funder);
    const tx = await factory.deploy(bytecode, salt);
    const rcpt = await tx.wait();
    const code = await prov.getCode(predicted);
    if (code === '0x') throw new Error('gator not at predicted address');
    state.gator = { address: predicted, salt, deployTx: rcpt.hash };
    saveState(state);
  }

  const gator = state.gator.address;
  const flz = new ethers.Contract(C.ADDR.flz, C.ERC20_IFACE, funder);
  const funding = state.funding || {};
  if (!funding.gatorEth) {
    funding.gatorEth = (await (await funder.sendTransaction({ to: gator, value: AMT.gatorEth })).wait()).hash;
  }
  if (!funding.gatorFlz) {
    funding.gatorFlz = (await (await flz.transfer(gator, AMT.gatorFlz)).wait()).hash;
  }
  if (!funding.delegateEth) {
    funding.delegateEth = (await (await funder.sendTransaction({ to: delegate.address, value: AMT.delegateEth })).wait()).hash;
  }
  state.funding = funding;
  saveState(state);

  const snap = await snapshot(prov, state, 'after S2 deploy');
  const bal = await balances(prov, { gator });
  const ok =
    snap.owner === owner.address &&
    bal.gator.eth >= AMT.gatorEth &&
    bal.gator.flz >= AMT.gatorFlz &&
    state.erc20Enforcer.runtimeMatchesArtifact;
  return record(state, 'S2', ok ? 'PASS' : 'FAIL', {
    gator,
    owner: snap.owner,
    codeKeccak: snap.codeKeccak,
    gatorEth: s(bal.gator.eth),
    gatorFlz: s(bal.gator.flz),
    erc20Enforcer: state.erc20Enforcer,
    deployTx: state.gator.deployTx,
    funding,
  });
}

// ---------------------------------------------------------------------------
// Delegations
// ---------------------------------------------------------------------------

function timestampTerms(beforeSeconds) {
  return C.packU128(0, beforeSeconds);
}

function ethDelegation(state, salt, before) {
  return {
    delegate: state.roles.delegate,
    delegator: state.gator.address,
    authority: C.ROOT_AUTHORITY,
    caveats: [
      { enforcer: C.ADDR.nativeAmountEnforcer, terms: ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [AMT.ethCap]), args: '0x' },
      { enforcer: C.ADDR.timestampEnforcer, terms: timestampTerms(before), args: '0x' },
      { enforcer: C.ADDR.allowedTargetsEnforcer, terms: ethers.getAddress(state.sink), args: '0x' },
    ],
    salt: salt.toString(),
    signature: '0x',
  };
}

function flzDelegation(state, salt, before) {
  return {
    delegate: state.roles.delegate,
    delegator: state.gator.address,
    authority: C.ROOT_AUTHORITY,
    caveats: [
      { enforcer: state.erc20Enforcer.address, terms: ethers.concat([C.ADDR.flz, ethers.toBeHex(AMT.flzCap, 32)]), args: '0x' },
      { enforcer: C.ADDR.nativeAmountEnforcer, terms: ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [0n]), args: '0x' },
      { enforcer: C.ADDR.timestampEnforcer, terms: timestampTerms(before), args: '0x' },
      { enforcer: C.ADDR.allowedTargetsEnforcer, terms: C.ADDR.flz, args: '0x' },
    ],
    salt: salt.toString(),
    signature: '0x',
  };
}

/** Local digest must equal the manager's own domain + struct hash. */
async function checkDelegationDigest(prov, d) {
  const dm = new ethers.Contract(C.ADDR.delegationManager, C.DM_IFACE, prov);
  const domainHash = await dm.getDomainHash();
  const structHash = await dm.getDelegationHash(C.delegationTuple(d));
  const onchain = ethers.keccak256(ethers.concat(['0x1901', domainHash, structHash]));
  const local = C.delegationDigest(d);
  if (onchain !== local) throw new Error(`delegation digest mismatch: local ${local} vs manager ${onchain}`);
  return local;
}

async function isValid(prov, gator, digest, sig) {
  const gatorC = new ethers.Contract(gator, C.GATOR_IFACE, prov);
  return gatorC.isValidSignature(digest, sig);
}

function redeemTx(d, target, value, callData, from) {
  return {
    from,
    to: C.ADDR.delegationManager,
    data: C.DM_IFACE.encodeFunctionData('redeemDelegations', [
      [C.permissionContext(d)],
      [C.MODE_SINGLE],
      [C.encodeSingle(target, value, callData)],
    ]),
  };
}

function signUserOpLocally(wallet, digest) {
  return wallet.signingKey.sign(digest).serialized;
}

// ---------------------------------------------------------------------------
// S3: ownership moves to the Privy wallet; the old owner's signature dies
// ---------------------------------------------------------------------------

async function s3Transfer() {
  const prov = C.provider();
  const { funder, owner, delegate } = wallets(prov);
  const state = loadState();
  requireStep(state, 'S1');
  requireStep(state, 'S2');
  const privy = state.privy.address;
  const gator = state.gator.address;
  const before = await snapshot(prov, state, 'before S3 transfer');
  if (before.owner !== owner.address) throw new Error(`owner is ${before.owner}, expected the throwaway owner`);

  // A delegation signed by the old owner, valid now.
  const now = (await prov.getBlock('latest')).timestamp;
  const oldD = ethDelegation(state, 1n, now + 86400);
  const oldDigest = await checkDelegationDigest(prov, oldD);
  oldD.signature = owner.signingKey.sign(oldDigest).serialized;
  const oldMagicBefore = await isValid(prov, gator, oldDigest, oldD.signature);
  const oldRedeemBefore = await C.callRevert(prov, redeemTx(oldD, state.sink, AMT.ethIn, '0x', delegate.address));

  // Owner-signed UserOp: execute(self, 0, transferOwnership(privy)).
  const inner = C.GATOR_IFACE.encodeFunctionData('transferOwnership', [privy]);
  const callData = C.GATOR_IFACE.encodeFunctionData('execute((address,uint256,bytes))', [[gator, 0, inner]]);
  const { op, digest } = await C.buildUserOp(prov, gator, callData);
  op.signature = signUserOpLocally(owner, digest);
  const sent = await C.submitUserOp(funder, op);

  const after = await snapshot(prov, state, 'after S3 transfer');
  const oldMagicAfter = await isValid(prov, gator, oldDigest, oldD.signature);
  const oldRedeemAfter = await C.callRevert(prov, redeemTx(oldD, state.sink, AMT.ethIn, '0x', delegate.address));

  // The old owner can no longer sign a UserOp either.
  const probe = await C.buildUserOp(prov, gator, C.GATOR_IFACE.encodeFunctionData('execute((address,uint256,bytes))', [[state.sink, AMT.ethIn, '0x']]));
  const oldOwnerUserOpMagic = await isValid(prov, gator, probe.digest, signUserOpLocally(owner, probe.digest));

  const ok =
    sent.success &&
    after.owner === privy &&
    after.address === before.address &&
    after.codeKeccak === before.codeKeccak &&
    oldMagicBefore === C.MAGIC &&
    oldRedeemBefore === null &&
    oldMagicAfter === C.SIG_FAILED &&
    oldRedeemAfter !== null &&
    oldOwnerUserOpMagic === C.SIG_FAILED;

  return record(state, 'S3', ok ? 'PASS' : 'FAIL', {
    transferTx: sent.tx,
    userOpSuccess: sent.success,
    ownerBefore: before.owner,
    ownerAfter: after.owner,
    addressUnchanged: after.address === before.address,
    codeUnchanged: after.codeKeccak === before.codeKeccak,
    oldDelegationDigest: oldDigest,
    oldOwnerDelegationMagicBefore: oldMagicBefore,
    oldDelegationRedeemBefore: oldRedeemBefore ? oldRedeemBefore.text : 'would succeed',
    oldOwnerDelegationMagicAfter: oldMagicAfter,
    oldDelegationRedeemAfter: oldRedeemAfter ? oldRedeemAfter.text : 'would succeed',
    oldOwnerUserOpMagicAfter: oldOwnerUserOpMagic,
  });
}

// ---------------------------------------------------------------------------
// S4: the Privy wallet signs the production-caveat delegations
// ---------------------------------------------------------------------------

async function s4Payload() {
  const prov = C.provider();
  const state = loadState();
  requireStep(state, 'S3');
  const now = (await prov.getBlock('latest')).timestamp;
  const before = now + 86400;
  const eth = ethDelegation(state, BigInt(now) * 10n + 2n, before);
  const flz = flzDelegation(state, BigInt(now) * 10n + 3n, before);
  await checkDelegationDigest(prov, eth);
  await checkDelegationDigest(prov, flz);
  state.pendingDelegations = { eth, flz };
  saveState(state);
  const td = (d) => C.typedDataJson(C.delegationDomain(), C.DELEGATION_TYPES, 'Delegation', C.delegationMessage(d));
  return { address: state.privy.address, eth: td(eth), flz: td(flz) };
}

async function s4Verify(body) {
  const prov = C.provider();
  const state = loadState();
  if (!state.pendingDelegations) throw new Error('request the S4 payload first');
  const { eth, flz } = state.pendingDelegations;
  eth.signature = requireSig(body.ethSig, 'ethSig');
  flz.signature = requireSig(body.flzSig, 'flzSig');
  const gator = state.gator.address;
  const out = {};
  for (const [name, d] of Object.entries({ eth, flz })) {
    const digest = C.delegationDigest(d);
    out[name] = {
      digest,
      recovered: ethers.recoverAddress(digest, d.signature),
      magic: await isValid(prov, gator, digest, d.signature),
    };
  }
  const ok = ['eth', 'flz'].every((k) => out[k].magic === C.MAGIC && out[k].recovered === state.privy.address);
  if (ok) {
    state.delegations = { eth, flz };
    delete state.pendingDelegations;
  }
  return record(state, 'S4', ok ? 'PASS' : 'FAIL', {
    signer: state.privy.address,
    eth: out.eth,
    flz: out.flz,
    caveats: {
      eth: 'NativeTokenTransferAmount cap 0.005 ETH, Timestamp before now+1d, AllowedTargets [sink]',
      flz: 'ERC20TransferAmount FLZ cap 10, NativeTokenTransferAmount cap 0, Timestamp before now+1d, AllowedTargets [FLZ]',
    },
  });
}

// ---------------------------------------------------------------------------
// S5: redemption by the Flizy stand-in delegate
// ---------------------------------------------------------------------------

async function sendRedeem(prov, delegate, tx, watch) {
  const sent = await delegate.sendTransaction({ to: tx.to, data: tx.data });
  const rcpt = await sent.wait();
  const delta = await deltaAcross(prov, watch, rcpt.blockNumber);
  return { tx: rcpt.hash, block: rcpt.blockNumber, status: rcpt.status, gasUsed: s(rcpt.gasUsed), delta };
}

async function s5Redeem() {
  const prov = C.provider();
  const { delegate } = wallets(prov);
  const state = loadState();
  requireStep(state, 'S4');
  const { eth, flz } = state.delegations;
  const gator = state.gator.address;
  const watch = { gator, sink: state.sink };
  const flzTransfer = (amount) => C.ERC20_IFACE.encodeFunctionData('transfer', [state.sink, amount]);

  const a = await sendRedeem(prov, delegate, redeemTx(eth, state.sink, AMT.ethIn, '0x', delegate.address), watch);
  const b = await C.callRevert(prov, redeemTx(eth, state.sink, AMT.ethOut, '0x', delegate.address));
  const c = await sendRedeem(prov, delegate, redeemTx(flz, C.ADDR.flz, 0n, flzTransfer(AMT.flzIn), delegate.address), watch);
  const cOut = await C.callRevert(prov, redeemTx(flz, C.ADDR.flz, 0n, flzTransfer(AMT.flzOut), delegate.address));

  const aOk = a.status === 1 && a.delta.sink.eth === s(AMT.ethIn) && a.delta.gator.eth === s(-AMT.ethIn);
  const bOk = b !== null && /NativeTokenTransferAmountEnforcer:allowance-exceeded/.test(b.text);
  const cOk = c.status === 1 && c.delta.sink.flz === s(AMT.flzIn) && c.delta.gator.flz === s(-AMT.flzIn);
  const cOutOk = cOut !== null && /ERC20TransferAmountEnforcer:allowance-exceeded/.test(cOut.text);

  return record(state, 'S5', aOk && bOk && cOk && cOutOk ? 'PASS' : 'FAIL', {
    a_ethInBounds: { ok: aOk, amount: '0.001 ETH', ...a },
    b_ethOutOfBounds: { ok: bOk, amount: '0.01 ETH', revert: b },
    c_flzInBounds: { ok: cOk, amount: '1 FLZ', ...c },
    c_flzOutOfBounds: { ok: cOutOk, amount: '20 FLZ', revert: cOut },
  });
}

// ---------------------------------------------------------------------------
// S6 and S7: UserOps signed by the Privy owner, submitted by the relayer
// ---------------------------------------------------------------------------

async function userOpPayload(step, callData) {
  const prov = C.provider();
  const state = loadState();
  const { op, digest } = await C.buildUserOp(prov, state.gator.address, callData);
  state.pendingUserOp = { step, op, digest };
  saveState(state);
  return {
    address: state.privy.address,
    digest,
    typedData: C.typedDataJson(C.userOpDomain(op.sender), C.USEROP_TYPES, 'PackedUserOperation', C.userOpMessage(op)),
  };
}

async function submitPending(step, sig) {
  const prov = C.provider();
  const { funder } = wallets(prov);
  const state = loadState();
  const pending = state.pendingUserOp;
  if (!pending || pending.step !== step) throw new Error(`request the ${step} payload first`);
  const op = { ...pending.op, signature: requireSig(sig, 'signature') };
  const recovered = ethers.recoverAddress(pending.digest, op.signature);
  const magic = await isValid(prov, state.gator.address, pending.digest, op.signature);
  if (magic !== C.MAGIC) {
    return { state, op, recovered, magic, sent: null };
  }
  const sent = await C.submitUserOp(funder, op);
  delete state.pendingUserOp;
  saveState(state);
  return { state, op, recovered, magic, sent };
}

async function s6Payload() {
  const state = loadState();
  requireStep(state, 'S5');
  const inner = C.DM_IFACE.encodeFunctionData('disableDelegation', [C.delegationTuple(state.delegations.eth)]);
  const callData = C.GATOR_IFACE.encodeFunctionData('execute((address,uint256,bytes))', [[C.ADDR.delegationManager, 0, inner]]);
  return userOpPayload('S6', callData);
}

async function s6Submit(body) {
  const { state, recovered, magic, sent } = await submitPending('S6', body.signature);
  const prov = C.provider();
  const { delegate } = wallets(prov);
  const dm = new ethers.Contract(C.ADDR.delegationManager, C.DM_IFACE, prov);
  const ethHash = C.delegationDigest(state.delegations.eth);
  const structHash = await dm.getDelegationHash(C.delegationTuple(state.delegations.eth));
  const disabled = await dm.disabledDelegations(structHash);
  const replay = await C.callRevert(prov, redeemTx(state.delegations.eth, state.sink, AMT.ethIn, '0x', delegate.address));
  const ok = Boolean(sent && sent.success) && disabled && replay !== null && /CannotUseADisabledDelegation/.test(replay.text);
  return record(state, 'S6', ok ? 'PASS' : 'FAIL', {
    signer: recovered,
    userOpSignatureMagic: magic,
    disableTx: sent ? sent.tx : null,
    userOpSuccess: sent ? sent.success : false,
    delegationDigest: ethHash,
    disabled,
    inBoundsReplay: replay ? replay.text : 'would succeed',
  });
}

async function s7Payload() {
  const state = loadState();
  requireStep(state, 'S6');
  const privy = state.privy.address;
  const callData = C.GATOR_IFACE.encodeFunctionData('execute(bytes32,bytes)', [
    C.MODE_BATCH,
    C.encodeBatch([
      { target: privy, value: AMT.exitEth, callData: '0x' },
      { target: C.ADDR.flz, value: 0n, callData: C.ERC20_IFACE.encodeFunctionData('transfer', [privy, AMT.exitFlz]) },
    ]),
  ]);
  return userOpPayload('S7', callData);
}

async function s7Submit(body) {
  const prov = C.provider();
  const state0 = loadState();
  const watch = { gator: state0.gator.address, privy: state0.privy.address };
  const { state, recovered, magic, sent } = await submitPending('S7', body.signature);
  const delta = sent ? await deltaAcross(prov, watch, sent.block) : null;
  const privyEthDelta = delta ? BigInt(delta.privy.eth) : 0n;
  const privyFlzDelta = delta ? BigInt(delta.privy.flz) : 0n;
  const ok = Boolean(sent && sent.success) && privyEthDelta === AMT.exitEth && privyFlzDelta === AMT.exitFlz;
  return record(state, 'S7', ok ? 'PASS' : 'FAIL', {
    signer: recovered,
    userOpSignatureMagic: magic,
    exitTx: sent ? sent.tx : null,
    userOpSuccess: sent ? sent.success : false,
    revertReason: sent ? sent.revertReason : null,
    path: 'Privy-signed PackedUserOperation, EntryPoint v0.7 handleOps sent directly by an EOA relayer, no bundler',
    exitEth: '0.01 ETH (twice the delegation cap)',
    exitFlz: '5 FLZ',
    privyEthDelta: s(privyEthDelta),
    privyFlzDelta: s(privyFlzDelta),
    exitBlock: sent ? sent.block : null,
    gatorEthDelta: delta ? delta.gator.eth : '0',
    gatorFlzDelta: delta ? delta.gator.flz : '0',
  });
}

// ---------------------------------------------------------------------------
// S8: the gator address and code never moved
// ---------------------------------------------------------------------------

async function s8Check() {
  const prov = C.provider();
  const state = loadState();
  requireStep(state, 'S7');
  const final = await snapshot(prov, state, 'S8 final');
  const snaps = state.snapshots;
  const ok =
    snaps.every((x) => x.address === state.gator.address && x.codeKeccak === snaps[0].codeKeccak) &&
    final.owner === state.privy.address;
  return record(state, 'S8', ok ? 'PASS' : 'FAIL', {
    address: state.gator.address,
    codeKeccak: snaps[0].codeKeccak,
    snapshots: snaps.map((x) => ({ label: x.label, block: x.block, owner: x.owner, sameCode: x.codeKeccak === snaps[0].codeKeccak })),
    finalOwner: final.owner,
  });
}

// ---------------------------------------------------------------------------
// S9: a guest MetaMask wallet connected through Privy does a self-transfer
// ---------------------------------------------------------------------------

async function s9Verify(body) {
  const prov = C.provider();
  const state = loadState();
  const address = requireAddress(body.address, 'address');
  if (typeof body.tx !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.tx)) throw new Error('tx: expected a transaction hash');
  const rcpt = await prov.waitForTransaction(body.tx, 1, 120_000);
  const tx = await prov.getTransaction(body.tx);
  const ok =
    rcpt !== null &&
    rcpt.status === 1 &&
    ethers.getAddress(tx.from) === address &&
    tx.to !== null &&
    ethers.getAddress(tx.to) === address &&
    Number(tx.chainId) === C.CHAIN_ID &&
    (!state.privy || address !== state.privy.address);
  return record(state, 'S9', ok ? 'PASS' : 'FAIL', {
    address,
    walletClientType: String(body.walletClientType || ''),
    tx: body.tx,
    status: rcpt ? rcpt.status : null,
    chainId: Number(tx.chainId),
    selfTransfer: tx.to !== null && ethers.getAddress(tx.from) === ethers.getAddress(tx.to),
    distinctFromEmbedded: !state.privy || address !== state.privy.address,
  });
}

function publicState() {
  const state = loadState();
  return {
    roles: state.roles || null,
    gator: state.gator || null,
    privy: state.privy || null,
    steps: state.steps,
  };
}

module.exports = {
  appendEnvLine,
  STATE_FILE,
  loadState,
  publicState,
  s1Challenge,
  s1Verify,
  s2Setup,
  s3Transfer,
  s4Payload,
  s4Verify,
  s5Redeem,
  s6Payload,
  s6Submit,
  s7Payload,
  s7Submit,
  s8Check,
  s9Verify,
};
