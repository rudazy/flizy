/**
 * Deploy one unmodified delegation-framework v1.3.0 enforcer to GIWA Sepolia:
 * ERC20TransferAmountEnforcer.
 *
 * It is what a one-off token permission needs and the chain does not have
 * yet. A one-off permission lets a passkey approve one payment over the daily
 * cap: exactly this recipient, exactly this amount, once, within minutes.
 *
 *   ETH needs nothing new. The call's target is the recipient and its value is
 *   the amount, so the deployed NativeTokenTransferAmountEnforcer (lifetime
 *   total = the amount, so it spends once), AllowedTargetsEnforcer (the
 *   recipient), ExactCalldataEnforcer (empty calldata) and TimestampEnforcer
 *   already pin it.
 *
 *   A token payment calls the token, and the recipient is inside the calldata,
 *   transfer(recipient, amount). The deployed ExactCalldataEnforcer can pin
 *   that whole call, recipient and amount, byte for byte. But exact calldata
 *   can be replayed until the permission expires, and none of the deployed
 *   enforcers stops that: the period enforcer refills every day. This one caps
 *   the lifetime total at the amount, so the permission spends once. It also
 *   requires the call to be IERC20.transfer on the named token.
 *
 * Pin: tag v1.3.0, commit bfbdf9795a976833ed2fa000baf42fbb83958b03. Never main.
 * Set DELEGATION_FRAMEWORK_ROOT to a clean local checkout of that tag. The
 * script deploys the foundry out/ bytecode. It does not recompile and it does
 * not patch bytecode. Its terms (token, amount) are caveat terms set per
 * permission. They are not constructor arguments.
 *
 * This script does not create a permission, does not deploy an account, and
 * does not change an owner.
 *
 * Default is a dry run. It checks the pin and the artifact, and an address
 * already recorded. It sends nothing. With --broadcast the ops key
 * (PRIVATE_KEY) deploys it, and the address is recorded in
 * deployments/giwa-sepolia-transfer-amount-enforcer.json only when the code
 * on chain is byte for byte the artifact's runtime code.
 *
 * Run from the repo root (Windows CMD):
 *   node scripts\delegation-giwa-transfer-amount-enforcer.js
 *   node scripts\delegation-giwa-transfer-amount-enforcer.js --broadcast
 */
require('dotenv').config({ quiet: true });
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPC = process.env.GIWA_RPC || 'https://sepolia-rpc.giwa.io';
const CHAIN_ID = 91342;
const TAG = 'v1.3.0';
const TAG_COMMIT = 'bfbdf9795a976833ed2fa000baf42fbb83958b03';
const FRAMEWORK_ROOT = process.env.DELEGATION_FRAMEWORK_ROOT;
const OUT_PATH = path.join(__dirname, '..', 'deployments', 'giwa-sepolia-transfer-amount-enforcer.json');

const ITEM = { name: 'ERC20TransferAmountEnforcer', file: 'ERC20TransferAmountEnforcer.sol', key: 'erc20TransferAmountEnforcer' };

function parseArgs() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--broadcast');
  if (unknown.length) throw new Error(`unknown arg ${unknown[0]}`);
  return args.includes('--broadcast');
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function assertPin(root) {
  if (!root) throw new Error('Set DELEGATION_FRAMEWORK_ROOT to a local checkout of MetaMask/delegation-framework tag v1.3.0');
  const head = git(root, ['rev-parse', 'HEAD']).toLowerCase();
  if (head !== TAG_COMMIT) throw new Error(`framework HEAD ${head} is not ${TAG} ${TAG_COMMIT}`);
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).toLowerCase();
  if (branch === 'main' || branch === 'master') throw new Error(`refusing branch ${branch}. Checkout tag ${TAG}.`);
  if (git(root, ['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('framework checkout has tracked changes. Use a clean v1.3.0 tag.');
  }
}

function bytecodeObject(section, label) {
  if (!section || typeof section.object !== 'string' || section.object.length < 4) throw new Error(`${label} is missing bytecode.object`);
  return section.object.startsWith('0x') ? section.object : `0x${section.object}`;
}

/** The artifact, refused if it is linked, takes constructor arguments, or is not 0.8.23. */
function loadArtifact(root) {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'out', ITEM.file, `${ITEM.name}.json`), 'utf8'));
  const creation = bytecodeObject(artifact.bytecode, `${ITEM.name} creation`);
  const runtime = bytecodeObject(artifact.deployedBytecode, `${ITEM.name} runtime`);
  for (const [label, hex] of [['creation', creation], ['runtime', runtime]]) {
    if (hex.includes('_') || hex.includes('$')) throw new Error(`${ITEM.name} ${label} bytecode has a link placeholder. Refusing to deploy it.`);
  }
  const refs = [artifact.bytecode && artifact.bytecode.linkReferences, artifact.deployedBytecode && artifact.deployedBytecode.linkReferences];
  if (refs.some((r) => r && Object.keys(r).length)) throw new Error(`${ITEM.name} has link references. Refusing to deploy it.`);
  const ctor = (artifact.abi || []).find((entry) => entry.type === 'constructor');
  if (ctor && ctor.inputs && ctor.inputs.length) throw new Error(`${ITEM.name} constructor takes arguments. This script deploys none.`);
  let meta = artifact.metadata;
  if (typeof meta === 'string') meta = JSON.parse(meta);
  const version = meta && meta.compiler && meta.compiler.version;
  if (!version || !version.startsWith('0.8.23')) throw new Error(`${ITEM.name} compiler ${version} is not 0.8.23`);
  return { artifact, creation, runtime };
}

function readDoc() {
  return fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : null;
}

function freshDoc() {
  return {
    chainId: CHAIN_ID,
    chainName: 'GIWA Sepolia',
    explorer: 'https://sepolia-explorer.giwa.io',
    rpc: 'https://sepolia-rpc.giwa.io',
    note: 'Unmodified delegation-framework v1.3.0 ERC20TransferAmountEnforcer on GIWA Sepolia, for one-off token permissions. The token and amount are caveat terms per permission, not stored here. This record does not create a permission and does not change an owner.',
    pin: { repo: 'https://github.com/MetaMask/delegation-framework', tag: TAG, commit: TAG_COMMIT, neverMain: true },
    terms: 'abi.encodePacked(address token, uint256 maxAmount): 52 bytes per permission',
    contracts: {},
    deployTxs: {},
    bytecode: {},
    rejected: {},
  };
}

function saveDoc(doc) {
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(doc, null, 2)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runtimeMatch(provider, address, runtime) {
  // A receipt can be visible before eth_getCode on the same RPC.
  let code = '0x';
  for (let attempt = 0; attempt < 10 && (!code || code === '0x'); attempt += 1) {
    code = await provider.getCode(address);
    if (!code || code === '0x') await sleep(1000);
  }
  const artifactKeccak = ethers.keccak256(runtime);
  if (!code || code === '0x') return { exact: false, empty: true, deployedKeccak: null, artifactKeccak, code: '0x' };
  const deployedKeccak = ethers.keccak256(code);
  return { exact: deployedKeccak === artifactKeccak, empty: false, deployedKeccak, artifactKeccak, code };
}

async function main() {
  const broadcast = parseArgs();
  assertPin(FRAMEWORK_ROOT);
  const { artifact, creation, runtime } = loadArtifact(FRAMEWORK_ROOT);
  console.log(`${ITEM.name} runtime ${ethers.keccak256(runtime)}`);

  const doc = readDoc();
  const known = doc && doc.contracts && doc.contracts[ITEM.key];
  if (known) {
    const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
    const match = await runtimeMatch(provider, known, runtime);
    if (match.empty) throw new Error(`${ITEM.name} runtime code was not visible yet at ${known}`);
    if (!match.exact) throw new Error(`${ITEM.name} at ${known} does not match the v1.3.0 artifact. Not deploying another copy.`);
    console.log(`${ITEM.name} ${known} exact=true. Nothing to deploy.`);
    return;
  }

  if (!broadcast) {
    console.log('dry-run. Not deployed. Re-run with --broadcast to deploy.');
    return;
  }

  if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY missing from env');
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`wrong chain ${net.chainId}`);
  const ops = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log('deployer', ops.address);
  if ((await provider.getBalance(ops.address)) === 0n) throw new Error('deployer balance is 0');

  const factory = new ethers.ContractFactory(artifact.abi, creation, ops);
  const contract = await factory.deploy();
  const receipt = await contract.deploymentTransaction().wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${ITEM.name} deploy transaction failed`);
  const addr = await contract.getAddress();
  const match = await runtimeMatch(provider, addr, runtime);
  const row = {
    address: addr,
    tx: receipt.hash,
    gasUsed: receipt.gasUsed.toString(),
    deployedBytes: match.empty ? 0 : (match.code.length - 2) / 2,
    deployedKeccak: match.deployedKeccak,
    artifactKeccak: match.artifactKeccak,
    creationKeccak: ethers.keccak256(creation),
    exactRuntimeMatch: match.exact,
  };
  const out = doc || freshDoc();
  if (match.empty) throw new Error(`${ITEM.name} runtime code was not visible yet at ${addr}`);
  if (!match.exact) {
    out.rejected[ITEM.name] = row;
    saveDoc(out);
    throw new Error(`${ITEM.name} runtime bytecode does not match the v1.3.0 artifact at ${addr}`);
  }
  out.contracts[ITEM.key] = addr;
  out.deployTxs[ITEM.key] = receipt.hash;
  out.bytecode[ITEM.name] = row;
  saveDoc(out);
  console.log(`${ITEM.name} ${addr} exact=true`);
  console.log('recorded', OUT_PATH);
}

main().catch((err) => {
  console.error(err && err.shortMessage ? err.shortMessage : err.message || err);
  process.exit(1);
});
