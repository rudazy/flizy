/**
 * Read-only: compare GIWA Sepolia runtime bytecode against the v1.3.0
 * artifacts. Does not deploy. Does not send a transaction.
 *
 * Pin: MetaMask delegation-framework v1.3.0 (bfbdf97). Never main.
 * Set DELEGATION_FRAMEWORK_ROOT to a local clone of that tag.
 *
 * Run (Windows CMD):
 *   node scripts\delegation-giwa-bytecode.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPC = process.env.GIWA_RPC || 'https://sepolia-rpc.giwa.io';
const CHAIN_ID = 91342;
const FRAMEWORK_ROOT = process.env.DELEGATION_FRAMEWORK_ROOT;
if (!FRAMEWORK_ROOT) {
  throw new Error(
    'Set DELEGATION_FRAMEWORK_ROOT to a local clone of MetaMask/delegation-framework tag v1.3.0'
  );
}
const DEPLOYMENTS = path.join(__dirname, '..', 'deployments', 'giwa-sepolia-delegation.json');

const CANONICAL = {
  SimpleFactory: '0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c',
  DelegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
  HybridDeleGatorImpl: '0x48dBe696A4D990079e039489bA2053B36E8FFEC4',
};

function art(solFile, name) {
  const p = path.join(FRAMEWORK_ROOT, 'out', solFile, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function stripMeta(code) {
  const hex = String(code || '0x').toLowerCase();
  const idx = hex.lastIndexOf('a2646970667358');
  if (idx < 2) return hex;
  return hex.slice(0, idx);
}

function keccakHex(hex) {
  const h = String(hex || '0x');
  if (h.includes('_') || h.includes('$')) return 'unlinked-artifact';
  try {
    return ethers.keccak256(h === '0x' || h === '0x0' ? '0x' : h);
  } catch {
    return 'invalid-byteslike';
  }
}

function linkedBytecode(artifact, libraries, which) {
  let bytecode = artifact[which].object;
  const refs = artifact[which].linkReferences || {};
  for (const names of Object.values(refs)) {
    for (const [libName, spots] of Object.entries(names)) {
      const addr = libraries[libName];
      if (!addr) throw new Error(`missing library ${libName}`);
      const raw = addr.toLowerCase().replace(/^0x/, '');
      for (const spot of spots) {
        const start = 2 + spot.start * 2;
        const end = start + spot.length * 2;
        bytecode = bytecode.slice(0, start) + raw + bytecode.slice(end);
      }
    }
  }
  return bytecode;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`wrong chain ${net.chainId}`);
  }
  const dep = JSON.parse(fs.readFileSync(DEPLOYMENTS, 'utf8'));
  const c = dep.contracts;
  const sclAddr = '0x2E5d71461951B459aE837714a9EB143c0f2548F9';

  const artifacts = {
    SimpleFactory: art('SimpleFactory.sol', 'SimpleFactory'),
    DelegationManager: art('DelegationManager.sol', 'DelegationManager'),
    HybridDeleGator: art('HybridDeleGator.sol', 'HybridDeleGator'),
    SCL_RIP7212: art('libSCL_RIP7212.sol', 'SCL_RIP7212'),
    NativeTokenTransferAmountEnforcer: art(
      'NativeTokenTransferAmountEnforcer.sol',
      'NativeTokenTransferAmountEnforcer'
    ),
    TimestampEnforcer: art('TimestampEnforcer.sol', 'TimestampEnforcer'),
    AllowedTargetsEnforcer: art('AllowedTargetsEnforcer.sol', 'AllowedTargetsEnforcer'),
  };

  const hybridLinked = linkedBytecode(artifacts.HybridDeleGator, {
    SCL_RIP7212: sclAddr,
  }, 'deployedBytecode');

  const targets = [
    ['SimpleFactory', c.simpleFactory, artifacts.SimpleFactory.deployedBytecode.object, false],
    ['DelegationManager', c.delegationManager, artifacts.DelegationManager.deployedBytecode.object, true],
    ['SCL_RIP7212', sclAddr, artifacts.SCL_RIP7212.deployedBytecode.object, false],
    ['HybridDeleGator', c.hybridDeleGatorImpl, hybridLinked, true],
    [
      'NativeTokenTransferAmountEnforcer',
      c.nativeTokenTransferAmountEnforcer,
      artifacts.NativeTokenTransferAmountEnforcer.deployedBytecode.object,
      false,
    ],
    ['TimestampEnforcer', c.timestampEnforcer, artifacts.TimestampEnforcer.deployedBytecode.object, false],
    [
      'AllowedTargetsEnforcer',
      c.allowedTargetsEnforcer,
      artifacts.AllowedTargetsEnforcer.deployedBytecode.object,
      false,
    ],
  ];

  console.log('chainId', Number(net.chainId));
  console.log('--- canonical CREATE2 (salt GATOR) ---');
  for (const [name, addr] of Object.entries(CANONICAL)) {
    const code = await provider.getCode(addr);
    const bytes = code === '0x' ? 0 : (code.length - 2) / 2;
    console.log(name, addr, 'codeBytes', bytes);
  }

  console.log('--- ops-deployed vs v1.3.0 artifact ---');
  const rows = {};
  for (const [name, addr, artRuntime, expectImmutableDiff] of targets) {
    const code = await provider.getCode(addr);
    const deployedBytes = code === '0x' ? 0 : (code.length - 2) / 2;
    const artHash = keccakHex(artRuntime);
    const deployedHash = keccakHex(code);
    const exact = artHash === deployedHash && !String(artHash).startsWith('unlinked');
    const stripped =
      !String(artRuntime).includes('_') &&
      !String(artRuntime).includes('$') &&
      stripMeta(code) === stripMeta(artRuntime) &&
      stripMeta(code).length > 10;
    const unlinked = String(artRuntime).includes('_') || String(artRuntime).includes('$');
    rows[name] = {
      address: addr,
      deployedBytes,
      exactRuntimeMatch: exact,
      metadataStrippedMatch: stripped,
      artifactUnlinked: unlinked,
      expectImmutableDiff,
      deployedKeccak: deployedHash,
      artifactKeccak: artHash,
    };
    console.log(
      name,
      addr,
      'bytes',
      deployedBytes,
      'exact',
      exact,
      'stripped',
      stripped,
      'expectImmutableDiff',
      expectImmutableDiff
    );
  }

  const account = dep.experimentAccount.address;
  const accountCode = await provider.getCode(account);
  const accountContract = new ethers.Contract(
    account,
    ['function owner() view returns (address)', 'function getKeyIdHashesCount() view returns (uint256)'],
    provider
  );
  const owner = await accountContract.owner();
  const keyCount = await accountContract.getKeyIdHashesCount();
  console.log('--- account ---');
  console.log('address', account);
  console.log('codeBytes', (accountCode.length - 2) / 2);
  console.log('codeKeccak', keccakHex(accountCode));
  console.log('owner', owner);
  console.log('keyCount', keyCount.toString());

  const disabledSel = ethers.id('CannotUseADisabledDelegation()').slice(0, 10);
  console.log('--- selectors ---');
  console.log('CannotUseADisabledDelegation', disabledSel);

  const epCode = await provider.getCode(dep.entryPointV07);
  console.log('entryPointV07 codeBytes', epCode === '0x' ? 0 : (epCode.length - 2) / 2);

  fs.writeFileSync(
    path.join(__dirname, '..', 'tasks', 'delegation-giwa-bytecode.json'),
    `${JSON.stringify({ chainId: CHAIN_ID, canonicalEmpty: true, rows, account: { address: account, owner, keyCount: keyCount.toString(), codeKeccak: keccakHex(accountCode) }, disabledSelector: disabledSel }, null, 2)}\n`
  );
}

main().catch((err) => {
  console.error(err && err.shortMessage ? err.shortMessage : err);
  process.exit(1);
});
