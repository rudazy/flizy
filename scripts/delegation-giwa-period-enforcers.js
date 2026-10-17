/**
 * Deploy four unmodified delegation-framework v1.3.0 enforcers to GIWA Sepolia.
 *
 * NativeTokenPeriodTransferEnforcer
 * ERC20PeriodTransferEnforcer
 * ExactCalldataEnforcer
 * ValueLteEnforcer
 *
 * Pin: tag v1.3.0, commit bfbdf9795a976833ed2fa000baf42fbb83958b03. Never main.
 * Set DELEGATION_FRAMEWORK_ROOT to a clean local checkout of that tag.
 * The script deploys the foundry out/ bytecode. It does not recompile and
 * it does not patch bytecode.
 *
 * ExactCalldataEnforcer terms for a native delegation are empty (0x).
 * ValueLteEnforcer terms for an ERC-20 delegation are 32 zero bytes.
 * Those are caveat terms. They are not constructor arguments.
 * Period amount, duration, and start date are not set here.
 *
 * This script does not create a delegation, does not deploy an account,
 * and does not change an owner.
 *
 * Default is a dry run. It checks the pin and the artifacts, and any
 * address already recorded. It sends nothing. If a previously rejected
 * address now matches the artifact, the dry run records that address.
 *
 * Run from the repo root (Windows CMD):
 *   node scripts\delegation-giwa-period-enforcers.js
 *   node scripts\delegation-giwa-period-enforcers.js --broadcast
 */
require('dotenv').config();
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPC = process.env.GIWA_RPC || 'https://sepolia-rpc.giwa.io';
const CHAIN_ID = 91342;
const TAG = 'v1.3.0';
const TAG_COMMIT = 'bfbdf9795a976833ed2fa000baf42fbb83958b03';
const FRAMEWORK_ROOT = process.env.DELEGATION_FRAMEWORK_ROOT;
const OUT_PATH = path.join(__dirname, '..', 'deployments', 'giwa-sepolia-period-enforcers.json');

const EMPTY_TERMS = '0x';
const ZERO_U256_TERMS = `0x${'00'.repeat(32)}`;

const ENFORCERS = [
  {
    name: 'NativeTokenPeriodTransferEnforcer',
    file: 'NativeTokenPeriodTransferEnforcer.sol',
    key: 'nativeTokenPeriodTransferEnforcer',
  },
  {
    name: 'ERC20PeriodTransferEnforcer',
    file: 'ERC20PeriodTransferEnforcer.sol',
    key: 'erc20PeriodTransferEnforcer',
  },
  {
    name: 'ExactCalldataEnforcer',
    file: 'ExactCalldataEnforcer.sol',
    key: 'exactCalldataEnforcer',
    caveatTerms: EMPTY_TERMS,
  },
  {
    name: 'ValueLteEnforcer',
    file: 'ValueLteEnforcer.sol',
    key: 'valueLteEnforcer',
    caveatTerms: ZERO_U256_TERMS,
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--broadcast');
  if (unknown.length) throw new Error(`unknown arg ${unknown[0]}`);
  return args.includes('--broadcast');
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertPin(root) {
  if (!root) {
    throw new Error(
      'Set DELEGATION_FRAMEWORK_ROOT to a local checkout of MetaMask/delegation-framework tag v1.3.0'
    );
  }
  const head = git(root, ['rev-parse', 'HEAD']).toLowerCase();
  if (head !== TAG_COMMIT) {
    throw new Error(`framework HEAD ${head} is not ${TAG} ${TAG_COMMIT}`);
  }
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).toLowerCase();
  if (branch === 'main' || branch === 'master') {
    throw new Error(`refusing branch ${branch}. Checkout tag ${TAG}.`);
  }
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    throw new Error('framework checkout has tracked changes. Use a clean v1.3.0 tag.');
  }
}

function art(root, item) {
  const artifactPath = path.join(root, 'out', item.file, `${item.name}.json`);
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
}

function bytecodeObject(section, label) {
  if (!section || typeof section.object !== 'string' || section.object.length < 4) {
    throw new Error(`${label} is missing bytecode.object`);
  }
  return section.object.startsWith('0x') ? section.object : `0x${section.object}`;
}

function assertUnlinked(name, hex, label) {
  if (hex.includes('_') || hex.includes('$')) {
    throw new Error(`${name} ${label} has a link placeholder. Refusing to deploy it.`);
  }
}

function compilerVersion(artifact) {
  let meta = artifact.metadata;
  if (typeof meta === 'string') meta = JSON.parse(meta);
  const version = meta && meta.compiler && meta.compiler.version;
  if (!version) throw new Error('artifact metadata has no compiler version');
  return version;
}

function assertArtifact(item, artifact) {
  const creation = bytecodeObject(artifact.bytecode, `${item.name} creation`);
  const runtime = bytecodeObject(artifact.deployedBytecode, `${item.name} runtime`);
  assertUnlinked(item.name, creation, 'creation bytecode');
  assertUnlinked(item.name, runtime, 'runtime bytecode');
  const creationRefs = (artifact.bytecode && artifact.bytecode.linkReferences) || {};
  const runtimeRefs = (artifact.deployedBytecode && artifact.deployedBytecode.linkReferences) || {};
  if (Object.keys(creationRefs).length || Object.keys(runtimeRefs).length) {
    throw new Error(`${item.name} has link references. Refusing to deploy it.`);
  }
  const ctor = (artifact.abi || []).find((entry) => entry.type === 'constructor');
  if (ctor && ctor.inputs && ctor.inputs.length) {
    throw new Error(`${item.name} constructor takes arguments. This script deploys none.`);
  }
  const version = compilerVersion(artifact);
  if (!version.startsWith('0.8.23')) {
    throw new Error(`${item.name} compiler ${version} is not 0.8.23`);
  }
  return { creation, runtime };
}

function keccakHex(hex) {
  return ethers.keccak256(hex);
}

function readDoc() {
  if (!fs.existsSync(OUT_PATH)) return null;
  return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
}

function freshDoc() {
  return {
    chainId: CHAIN_ID,
    chainName: 'GIWA Sepolia',
    explorer: 'https://sepolia-explorer.giwa.io',
    rpc: 'https://sepolia-rpc.giwa.io',
    note: 'Unmodified delegation-framework v1.3.0 enforcers on GIWA Sepolia. Not production custody. Period caps are delegation terms and are not stored in these contracts. This record does not create a delegation and does not change an owner.',
    pin: {
      repo: 'https://github.com/MetaMask/delegation-framework',
      tag: TAG,
      commit: TAG_COMMIT,
      neverMain: true,
    },
    capAmounts: 'not stored in these contracts',
    pairing: {
      native: ['NativeTokenPeriodTransferEnforcer', 'ExactCalldataEnforcer'],
      erc20: ['ERC20PeriodTransferEnforcer', 'ValueLteEnforcer'],
    },
    caveatTerms: {
      exactCalldataEnforcer: EMPTY_TERMS,
      exactCalldataMeaning: 'Raw expected calldata. Empty terms force empty calldata on a native delegation.',
      valueLteEnforcer: ZERO_U256_TERMS,
      valueLteMeaning: 'uint256 maximum. 32 zero bytes force call value 0 on an ERC-20 delegation. Empty terms are invalid.',
    },
    contracts: {},
    deployTxs: {},
    bytecode: {},
    rejected: {},
  };
}

function saveDoc(doc) {
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(doc, null, 2)}\n`);
}

function recordedAddress(doc, item) {
  if (!doc) return null;
  if (doc.contracts && doc.contracts[item.key]) {
    return { address: doc.contracts[item.key], from: 'contracts' };
  }
  const rejected = doc.rejected && doc.rejected[item.name];
  if (rejected && rejected.address) return { address: rejected.address, from: 'rejected' };
  return null;
}

function adoptMatch(doc, item, address, match) {
  const prior = (doc.rejected && doc.rejected[item.name]) || {};
  doc.contracts[item.key] = address;
  doc.deployTxs[item.key] = prior.tx || doc.deployTxs[item.key];
  doc.bytecode[item.name] = {
    address,
    tx: prior.tx || null,
    gasUsed: prior.gasUsed || null,
    deployedBytes: (match.code.length - 2) / 2,
    deployedKeccak: match.deployedKeccak,
    artifactKeccak: match.artifactKeccak,
    creationKeccak: prior.creationKeccak || null,
    exactRuntimeMatch: true,
  };
  if (doc.rejected) delete doc.rejected[item.name];
  saveDoc(doc);
}

async function checkedProvider() {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`wrong chain ${net.chainId}`);
  }
  return provider;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runtimeMatch(provider, address, runtime) {
  // A receipt can be visible before eth_getCode on the same RPC.
  let code = '0x';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    code = await provider.getCode(address);
    if (code && code !== '0x') break;
    await sleep(1000);
  }
  if (!code || code === '0x') {
    return {
      exact: false,
      empty: true,
      deployedKeccak: null,
      artifactKeccak: keccakHex(runtime),
      code: '0x',
    };
  }
  const deployedKeccak = keccakHex(code);
  const artifactKeccak = keccakHex(runtime);
  return {
    exact: deployedKeccak === artifactKeccak,
    empty: false,
    deployedKeccak,
    artifactKeccak,
    code,
  };
}

async function deployOne(item, artifact, bytecode, ops, provider, doc) {
  const factory = new ethers.ContractFactory(artifact.abi, bytecode.creation, ops);
  const contract = await factory.deploy();
  const receipt = await contract.deploymentTransaction().wait();
  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error(`${item.name} deploy transaction failed`);
  }
  const addr = await contract.getAddress();
  const match = await runtimeMatch(provider, addr, bytecode.runtime);
  const row = {
    address: addr,
    tx: receipt.hash,
    gasUsed: receipt.gasUsed.toString(),
    deployedBytes: match.empty ? 0 : (match.code.length - 2) / 2,
    deployedKeccak: match.deployedKeccak,
    artifactKeccak: match.artifactKeccak,
    creationKeccak: keccakHex(bytecode.creation),
    exactRuntimeMatch: match.exact,
  };
  if (match.empty) {
    throw new Error(`${item.name} runtime code was not visible yet at ${addr}`);
  }
  if (!match.exact) {
    doc.rejected[item.name] = row;
    saveDoc(doc);
    throw new Error(
      `${item.name} runtime bytecode does not match the v1.3.0 artifact at ${addr}`
    );
  }
  doc.contracts[item.key] = addr;
  doc.deployTxs[item.key] = receipt.hash;
  doc.bytecode[item.name] = row;
  saveDoc(doc);
  console.log(`${item.name} ${addr} exact=true`);
}

async function main() {
  const broadcast = parseArgs();
  assertPin(FRAMEWORK_ROOT);
  const loaded = ENFORCERS.map((item) => {
    const artifact = art(FRAMEWORK_ROOT, item);
    const bytecode = assertArtifact(item, artifact);
    console.log(
      item.name,
      'runtime',
      keccakHex(bytecode.runtime),
      item.caveatTerms ? `terms ${item.caveatTerms}` : 'terms not set'
    );
    return { item, artifact, bytecode };
  });

  const docOnDisk = readDoc();
  const providerNeeded = broadcast || loaded.some(({ item }) => recordedAddress(docOnDisk, item));
  const provider = providerNeeded ? await checkedProvider() : null;
  const pending = [];
  const doc = docOnDisk || (broadcast ? freshDoc() : null);

  for (const row of loaded) {
    const known = recordedAddress(doc, row.item);
    if (!known) {
      console.log(`${row.item.name} not recorded`);
      pending.push(row);
      continue;
    }
    const match = await runtimeMatch(provider, known.address, row.bytecode.runtime);
    if (match.empty) {
      throw new Error(
        `${row.item.name} runtime code was not visible yet at ${known.address}`
      );
    }
    console.log(`${row.item.name} ${known.address} exact=${match.exact}`);
    if (!match.exact) {
      throw new Error(
        `${row.item.name} at ${known.address} does not match the v1.3.0 artifact. Not deploying another copy.`
      );
    }
    if (known.from === 'rejected') {
      adoptMatch(doc, row.item, known.address, match);
      console.log(`${row.item.name} adopted`);
    }
  }

  if (!broadcast) {
    console.log(
      pending.length
        ? `dry-run. ${pending.length} not deployed. Re-run with --broadcast to deploy.`
        : 'dry-run. all four match the v1.3.0 artifacts.'
    );
    return;
  }

  if (!pending.length) {
    console.log('nothing to deploy');
    return;
  }
  if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY missing from env');

  const ops = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log('deployer', ops.address);
  const balance = await provider.getBalance(ops.address);
  if (balance === 0n) throw new Error('deployer balance is 0');

  if (!doc.contracts) doc.contracts = {};
  if (!doc.deployTxs) doc.deployTxs = {};
  if (!doc.bytecode) doc.bytecode = {};
  if (!doc.rejected) doc.rejected = {};
  for (const row of pending) {
    await deployOne(row.item, row.artifact, row.bytecode, ops, provider, doc);
  }
  console.log('recorded', OUT_PATH);
}

main().catch((err) => {
  console.error(err && err.shortMessage ? err.shortMessage : err.message || err);
  process.exit(1);
});
