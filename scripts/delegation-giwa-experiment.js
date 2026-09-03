/**
 * GIWA Sepolia HybridDeleGator + ERC-7710 experiment.
 *
 * Research only. Does not touch production accounts, lib/, web/, or chat
 * clients. Signs with the ops key as EOA owner of ONE test account.
 *
 * Pin: MetaMask delegation-framework v1.3.0 (bfbdf97). Never main.
 * Set DELEGATION_FRAMEWORK_ROOT to a local clone of that tag.
 *
 * Do not re-run casually. Each run spends ops ETH and, if the account
 * already exists, issues a new delegation to a fresh random delegate.
 *
 * Run (Windows CMD):
 *   node scripts\delegation-giwa-experiment.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

const RPC = process.env.GIWA_RPC || 'https://sepolia-rpc.giwa.io';
const CHAIN_ID = 91342;
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const FRAMEWORK_ROOT = process.env.DELEGATION_FRAMEWORK_ROOT;
if (!FRAMEWORK_ROOT) {
  throw new Error(
    'Set DELEGATION_FRAMEWORK_ROOT to a local clone of MetaMask/delegation-framework tag v1.3.0'
  );
}
const TAG = 'v1.3.0';
const TAG_COMMIT = 'bfbdf9795a976833ed2fa000baf42fbb83958b03';
const EXPLORER = 'https://sepolia-explorer.giwa.io';

const ROOT_AUTHORITY =
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

const DELEGATION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    'Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)'
  )
);
const CAVEAT_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes('Caveat(address enforcer,bytes terms)')
);
const PACKED_USER_OP_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    'PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,address entryPoint)'
  )
);

const DISABLED_ERR = ethers.id('CannotUseADisabledDelegation()').slice(0, 10);

const CAP_WEI = ethers.parseEther('0.005');
const IN_BOUNDS_WEI = ethers.parseEther('0.001');
const OUT_BOUNDS_WEI = ethers.parseEther('0.01');
const ACCOUNT_FUND_WEI = ethers.parseEther('0.03');
const DELEGATE_FUND_WEI = ethers.parseEther('0.02');

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

function encodeSingle(target, value, callData) {
  return ethers.concat([
    ethers.getAddress(target),
    ethers.toBeHex(value, 32),
    callData && callData !== '0x' ? callData : '0x',
  ]);
}

function packU128(hi, lo) {
  return ethers.toBeHex((BigInt(hi) << 128n) | BigInt(lo), 32);
}

function caveatHash(enforcer, terms) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'bytes32'],
      [CAVEAT_TYPEHASH, enforcer, ethers.keccak256(terms)]
    )
  );
}

function caveatsArrayHash(caveats) {
  const hashes = caveats.map((c) => caveatHash(c.enforcer, c.terms));
  return ethers.keccak256(ethers.concat(hashes));
}

function delegationStructHash(d) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'address', 'bytes32', 'bytes32', 'uint256'],
      [
        DELEGATION_TYPEHASH,
        d.delegate,
        d.delegator,
        d.authority,
        caveatsArrayHash(d.caveats),
        d.salt,
      ]
    )
  );
}

function eip712Hash(domain, structHash) {
  const domainTypehash = ethers.keccak256(
    ethers.toUtf8Bytes(
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
    )
  );
  const domainSeparator = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        domainTypehash,
        ethers.id(domain.name),
        ethers.id(domain.version),
        domain.chainId,
        domain.verifyingContract,
      ]
    )
  );
  return ethers.keccak256(ethers.concat(['0x1901', domainSeparator, structHash]));
}

function decodeRevert(err) {
  const data =
    err.data ||
    err.info?.error?.data ||
    err.error?.data ||
    err.info?.error?.data?.data ||
    null;
  const hex =
    typeof data === 'string'
      ? data
      : data && typeof data.data === 'string'
        ? data.data
        : null;
  const short = err.shortMessage || err.reason || err.message || String(err);
  const out = { short, selector: null, string: null, custom: null, raw: hex };
  if (!hex || hex === '0x') return out;
  out.selector = hex.slice(0, 10);
  if (out.selector === '0x08c379a0') {
    try {
      out.string = ethers.AbiCoder.defaultAbiCoder().decode(
        ['string'],
        '0x' + hex.slice(10)
      )[0];
    } catch {
      try {
        out.string = ethers.AbiCoder.defaultAbiCoder().decode(
          ['string'],
          hex
        )[0];
      } catch {
        /* leave null */
      }
    }
  }
  if (out.selector === DISABLED_ERR) out.custom = 'CannotUseADisabledDelegation()';
  return out;
}

function p256Point() {
  const { publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  const buf = Buffer.from(publicKey);
  let idx = -1;
  for (let i = buf.length - 65; i >= 0; i -= 1) {
    if (buf[i] === 0x04) {
      idx = i;
      break;
    }
  }
  if (idx < 0 || buf.length - idx < 65) throw new Error('no uncompressed P-256 point');
  const xHex = buf.subarray(idx + 1, idx + 33).toString('hex');
  const yHex = buf.subarray(idx + 33, idx + 65).toString('hex');
  if (xHex.length !== 64 || yHex.length !== 64) throw new Error('bad P-256 coordinate length');
  return { x: BigInt('0x' + xHex), y: BigInt('0x' + yHex) };
}

async function main() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY missing from env');
  }
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`wrong chain ${net.chainId}`);
  }
  const ops = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const delegate = ethers.Wallet.createRandom().connect(provider);
  const sink = ethers.Wallet.createRandom().connect(provider);

  const log = {
    tag: TAG,
    commit: TAG_COMMIT,
    chainId: CHAIN_ID,
    rpc: RPC,
    ops: ops.address,
    delegate: delegate.address,
    sink: sink.address,
    entryPoint: ENTRY_POINT,
    deployed: {},
    bytecode: {},
    account: {},
    steps: {},
  };

  const opsBal = await provider.getBalance(ops.address);
  log.opsBalanceEth = ethers.formatEther(opsBal);
  if (opsBal < ethers.parseEther('0.08')) {
    throw new Error(`ops balance too low: ${log.opsBalanceEth} ETH`);
  }

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
    ERC1967Proxy: art('ERC1967Proxy.sol', 'ERC1967Proxy'),
  };

  function linkedBytecode(artifact, libraries) {
    let bytecode = artifact.bytecode.object;
    const refs = artifact.bytecode.linkReferences || {};
    for (const [file, names] of Object.entries(refs)) {
      for (const [libName, spots] of Object.entries(names)) {
        const addr = libraries[libName];
        if (!addr) throw new Error(`missing library ${libName} for ${file}`);
        const raw = addr.toLowerCase().replace(/^0x/, '');
        if (raw.length !== 40) throw new Error(`bad library address ${addr}`);
        for (const spot of spots) {
          const start = 2 + spot.start * 2;
          const end = start + spot.length * 2;
          bytecode = bytecode.slice(0, start) + raw + bytecode.slice(end);
        }
      }
    }
    if (bytecode.includes('__')) throw new Error('unlinked placeholder remains');
    return bytecode;
  }

  async function deploy(name, args, bytecodeOverride) {
    const a = artifacts[name];
    const bytecode = bytecodeOverride || a.bytecode.object;
    const factory = new ethers.ContractFactory(a.abi, bytecode, ops);
    const c = await factory.deploy(...args);
    const receipt = await c.deploymentTransaction().wait();
    const addr = await c.getAddress();
    const code = await provider.getCode(addr);
    const artRuntime = a.deployedBytecode.object;
    const artHash = keccakHex(artRuntime);
    const deployedHash = keccakHex(code);
    const exact = artHash === deployedHash && !String(artHash).startsWith('unlinked');
    const stripped =
      !String(artRuntime).includes('_') &&
      stripMeta(code) === stripMeta(artRuntime) &&
      stripMeta(code).length > 10;
    log.deployed[name] = {
      address: addr,
      tx: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
    };
    log.bytecode[name] = {
      deployedKeccak: deployedHash,
      artifactKeccak: artHash,
      deployedBytes: (code.length - 2) / 2,
      artifactBytes: (String(artRuntime).length - 2) / 2,
      exactRuntimeMatch: exact,
      metadataStrippedMatch: stripped,
      creationUsedArtifactBytecode: true,
    };
    console.log(
      `deployed ${name} ${addr} exact=${exact} stripped=${stripped} tx=${receipt.hash}`
    );
    return c;
  }

  async function attachOrDeploy(name, args, known, bytecodeOverride) {
    if (known) {
      const code = await provider.getCode(known);
      if (code && code !== '0x') {
        log.deployed[name] = { address: known, tx: 'resumed', gasUsed: '0' };
        log.bytecode[name] = { resumed: true, deployedBytes: (code.length - 2) / 2 };
        console.log(`resume ${name} ${known}`);
        return new ethers.Contract(known, artifacts[name].abi, ops);
      }
    }
    return deploy(name, args, bytecodeOverride);
  }

  const simpleFactory = await attachOrDeploy(
    'SimpleFactory',
    [],
    '0x78F5d9AC0aB718dE8AEA78F2E7E8864688F9c051'
  );
  const delegationManager = await attachOrDeploy(
    'DelegationManager',
    [ops.address],
    '0xB04c9b180d5C0F9854B3f9da5e702d10f0030d4B'
  );
  const scl = await attachOrDeploy(
    'SCL_RIP7212',
    [],
    '0x2E5d71461951B459aE837714a9EB143c0f2548F9'
  );
  const hybridBytecode = linkedBytecode(artifacts.HybridDeleGator, {
    SCL_RIP7212: await scl.getAddress(),
  });
  const hybridImpl = await attachOrDeploy(
    'HybridDeleGator',
    [await delegationManager.getAddress(), ENTRY_POINT],
    '0xC12F82BBbD43aA77371D9121acDF088224D4cC0c',
    hybridBytecode
  );
  const amountEnforcer = await attachOrDeploy(
    'NativeTokenTransferAmountEnforcer',
    [],
    '0x163bD4BDcb68c4913deeFFa265ec54007d6C03CF'
  );
  const timestampEnforcer = await attachOrDeploy(
    'TimestampEnforcer',
    [],
    '0x24DD7326ae2275fD9D505526f62a3843d174C2eF'
  );
  const targetsEnforcer = await attachOrDeploy(
    'AllowedTargetsEnforcer',
    [],
    '0x6b50AD84c6Ba42d227bD8f88bCdC4B53d3fdA405'
  );

  const hybridAddr = await hybridImpl.getAddress();
  const factoryAddr = await simpleFactory.getAddress();
  const dmAddr = await delegationManager.getAddress();

  const initData = hybridImpl.interface.encodeFunctionData('initialize', [
    ops.address,
    [],
    [],
    [],
  ]);
  const proxyArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes'],
    [hybridAddr, initData]
  );
  const proxyBytecode = ethers.concat([
    artifacts.ERC1967Proxy.bytecode.object,
    proxyArgs,
  ]);
  const salt = ethers.zeroPadValue(ethers.toBeHex(1), 32);
  const predicted = await simpleFactory.computeAddress(
    ethers.keccak256(proxyBytecode),
    salt
  );
  log.account.predicted = predicted;
  console.log('predicted account', predicted);

  let deployRcpt = { hash: 'resumed' };
  const existingAccountCode = await provider.getCode(predicted);
  if (existingAccountCode && existingAccountCode !== '0x') {
    console.log('resume account', predicted);
  } else {
    const deployTx = await simpleFactory.deploy(proxyBytecode, salt);
    deployRcpt = await deployTx.wait();
  }
  const deployedAccount = predicted;
  const codeAfter = await provider.getCode(deployedAccount);
  log.account.deployed = deployedAccount;
  log.account.deployTx = deployRcpt.hash;
  log.account.predictedMatchesDeployed =
    predicted.toLowerCase() === deployedAccount.toLowerCase();
  log.account.codeBytes = (codeAfter.length - 2) / 2;
  if (!log.account.predictedMatchesDeployed) {
    throw new Error('predicted address did not match deployed address');
  }
  if (codeAfter === '0x') throw new Error('account has no code');
  console.log('deployed account', deployedAccount, 'tx', deployRcpt.hash);

  const account = new ethers.Contract(
    deployedAccount,
    [
      ...artifacts.HybridDeleGator.abi,
      'function getNonce() view returns (uint256)',
      'function getNonce(uint192) view returns (uint256)',
    ],
    ops
  );
  const ownerBefore = await account.owner();
  log.account.owner = ownerBefore;
  if (ownerBefore.toLowerCase() !== ops.address.toLowerCase()) {
    throw new Error(`owner mismatch ${ownerBefore}`);
  }

  const fundTx = await ops.sendTransaction({
    to: deployedAccount,
    value: ACCOUNT_FUND_WEI,
  });
  await fundTx.wait();
  const fundDelegate = await ops.sendTransaction({
    to: delegate.address,
    value: DELEGATE_FUND_WEI,
  });
  await fundDelegate.wait();
  log.account.fundedTx = fundTx.hash;
  log.account.balanceAfterFund = ethers.formatEther(
    await provider.getBalance(deployedAccount)
  );

  const ep = new ethers.Contract(
    ENTRY_POINT,
    [
      'function getNonce(address sender, uint192 key) view returns (uint256)',
      'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary) payable',
    ],
    ops
  );

  async function signAndSendUserOp(callData) {
    const nonce = await ep.getNonce(deployedAccount, 0);
    const fee = await provider.getFeeData();
    const maxPrio = fee.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');
    const maxFee = fee.maxFeePerGas || maxPrio * 2n;
    const userOp = {
      sender: deployedAccount,
      nonce,
      initCode: '0x',
      callData,
      accountGasLimits: packU128(1_000_000, 500_000),
      preVerificationGas: 80_000,
      gasFees: packU128(maxPrio, maxFee),
      paymasterAndData: '0x',
      signature: '0x',
    };
    const structHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        [
          'bytes32',
          'address',
          'uint256',
          'bytes32',
          'bytes32',
          'bytes32',
          'uint256',
          'bytes32',
          'bytes32',
          'address',
        ],
        [
          PACKED_USER_OP_TYPEHASH,
          userOp.sender,
          userOp.nonce,
          ethers.keccak256(userOp.initCode),
          ethers.keccak256(userOp.callData),
          userOp.accountGasLimits,
          userOp.preVerificationGas,
          userOp.gasFees,
          ethers.keccak256(userOp.paymasterAndData),
          ENTRY_POINT,
        ]
      )
    );
    const typed = eip712Hash(
      {
        name: 'HybridDeleGator',
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: deployedAccount,
      },
      structHash
    );
    userOp.signature = ops.signingKey.sign(typed).serialized;
    const tx = await ep.handleOps([userOp], ops.address);
    const rcpt = await tx.wait();
    if (rcpt.status !== 1) throw new Error('handleOps failed');
    return rcpt;
  }

  const addrBeforeKey = ethers.getAddress(
    await provider.call({ to: deployedAccount, data: '0x' }).then(() => deployedAccount)
  );
  const onchainBefore = await provider.getCode(deployedAccount);
  log.steps.addressBeforeAddKey = addrBeforeKey;
  log.steps.codeKeccakBeforeAddKey = keccakHex(onchainBefore);

  const keysAlready = await account.getKeyIdHashesCount();
  let addKeyRcpt = { hash: 'skipped' };
  if (keysAlready === 0n) {
    const p256 = p256Point();
    const addKeyData = account.interface.encodeFunctionData('addKey', [
      'measure-p256',
      p256.x,
      p256.y,
    ]);
    const execAddKey = account.interface.encodeFunctionData('execute((address,uint256,bytes))', [
      {
        target: deployedAccount,
        value: 0,
        callData: addKeyData,
      },
    ]);
    addKeyRcpt = await signAndSendUserOp(execAddKey);
  } else {
    console.log('skip addKey, already', keysAlready.toString());
  }
  const addrAfterKey = ethers.getAddress(deployedAccount);
  const onchainAfter = await provider.getCode(deployedAccount);
  const keyCount = await account.getKeyIdHashesCount();
  const ownerAfterKey = await account.owner();
  log.steps.addKeyTx = addKeyRcpt.hash;
  log.steps.addressAfterAddKey = addrAfterKey;
  log.steps.codeKeccakAfterAddKey = keccakHex(onchainAfter);
  log.steps.addressUnchanged =
    addrBeforeKey.toLowerCase() === addrAfterKey.toLowerCase();
  log.steps.codeUnchanged =
    log.steps.codeKeccakBeforeAddKey === log.steps.codeKeccakAfterAddKey;
  log.steps.keyCountAfter = keyCount.toString();
  log.steps.ownerAfterAddKey = ownerAfterKey;
  console.log(
    'addKey address unchanged',
    log.steps.addressUnchanged,
    'keys',
    log.steps.keyCountAfter,
    'tx',
    addKeyRcpt.hash
  );

  const now = BigInt(Math.floor(Date.now() / 1000));
  const afterTs = 0n;
  const beforeTs = now + 60n * 60n * 24n;
  const tsTerms = ethers.concat([
    ethers.toBeHex(afterTs, 16),
    ethers.toBeHex(beforeTs, 16),
  ]);
  const amountTerms = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256'],
    [CAP_WEI]
  );
  const targetTerms = sink.address.toLowerCase().replace('0x', '');
  const caveats = [
    {
      enforcer: await amountEnforcer.getAddress(),
      terms: amountTerms,
      args: '0x',
    },
    {
      enforcer: await timestampEnforcer.getAddress(),
      terms: tsTerms,
      args: '0x',
    },
    {
      enforcer: await targetsEnforcer.getAddress(),
      terms: '0x' + targetTerms,
      args: '0x',
    },
  ];
  const delegation = {
    delegate: delegate.address,
    delegator: deployedAccount,
    authority: ROOT_AUTHORITY,
    caveats,
    salt: 1n,
    signature: '0x',
  };
  const delHash = eip712Hash(
    {
      name: 'DelegationManager',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: dmAddr,
    },
    delegationStructHash(delegation)
  );
  delegation.signature = ops.signingKey.sign(delHash).serialized;
  log.steps.delegationHashTyped = delHash;

  const dm = delegationManager.connect(delegate);
  const mode = ethers.ZeroHash;

  function delegationTuple(d) {
    return [
      d.delegate,
      d.delegator,
      d.authority,
      d.caveats.map((c) => [c.enforcer, c.terms, c.args]),
      d.salt,
      d.signature,
    ];
  }

  function redeemCalldata(valueWei) {
    const exec = encodeSingle(sink.address, valueWei, '0x');
    const ctx = ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)[]',
      ],
      [[delegationTuple(delegation)]]
    );
    return { ctx, exec };
  }

  async function redeem(valueWei, label) {
    const { ctx, exec } = redeemCalldata(valueWei);
    const sinkBefore = await provider.getBalance(sink.address);
    const accBefore = await provider.getBalance(deployedAccount);
    try {
      const tx = await dm.redeemDelegations([ctx], [mode], [exec]);
      const rcpt = await tx.wait();
      const sinkAfter = await provider.getBalance(sink.address);
      const accAfter = await provider.getBalance(deployedAccount);
      const result = {
        label,
        ok: rcpt.status === 1,
        tx: rcpt.hash,
        gasUsed: rcpt.gasUsed.toString(),
        sinkDelta: (sinkAfter - sinkBefore).toString(),
        accountDelta: (accAfter - accBefore).toString(),
        revert: null,
      };
      console.log(
        `${label} ok tx=${rcpt.hash} sinkDelta=${result.sinkDelta}`
      );
      return result;
    } catch (err) {
      const decoded = decodeRevert(err);
      const result = {
        label,
        ok: false,
        tx: err.receipt?.hash || null,
        gasUsed: null,
        sinkDelta: '0',
        accountDelta: '0',
        revert: decoded,
      };
      console.log(
        `${label} revert selector=${decoded.selector} string=${decoded.string} custom=${decoded.custom}`
      );
      return result;
    }
  }

  const caseA = await redeem(IN_BOUNDS_WEI, 'caseA_inBounds');
  log.steps.caseA = caseA;
  const caseB = await redeem(OUT_BOUNDS_WEI, 'caseB_outOfBounds');
  log.steps.caseB = caseB;

  const disableData = delegationManager.interface.encodeFunctionData(
    'disableDelegation',
    [delegationTuple(delegation)]
  );
  const execDisable = account.interface.encodeFunctionData('execute((address,uint256,bytes))', [
    { target: dmAddr, value: 0, callData: disableData },
  ]);
  const disableRcpt = await signAndSendUserOp(execDisable);
  log.steps.disableTx = disableRcpt.hash;
  console.log('disabled delegation', disableRcpt.hash);

  const caseAAfter = await redeem(IN_BOUNDS_WEI, 'caseA_afterDisable');
  log.steps.caseAAfterDisable = caseAAfter;

  const directCall = await (async () => {
    try {
      await dm.redeemDelegations(
        [redeemCalldata(IN_BOUNDS_WEI).ctx],
        [mode],
        [redeemCalldata(IN_BOUNDS_WEI).exec]
      );
      return { ok: true, note: 'unexpected success' };
    } catch (err) {
      return { ok: false, revert: decodeRevert(err) };
    }
  })();
  log.steps.delegateAfterDisable = directCall;

  const ownerExec = account.interface.encodeFunctionData('execute((address,uint256,bytes))', [
    { target: sink.address, value: IN_BOUNDS_WEI, callData: '0x' },
  ]);
  const ownerRcpt = await signAndSendUserOp(ownerExec);
  log.steps.ownerBypassTx = ownerRcpt.hash;
  log.steps.ownerBypassOk = ownerRcpt.status === 1;
  console.log('owner bypass', ownerRcpt.hash, 'status', ownerRcpt.status);

  const outPath = path.join(
    __dirname,
    '..',
    'deployments',
    'giwa-sepolia-delegation.json'
  );
  const json = {
    chainId: CHAIN_ID,
    chainName: 'GIWA Sepolia',
    explorer: EXPLORER,
    note:
      'RESEARCH ONLY. HybridDeleGator v1.3.0 experiment on GIWA Sepolia. Not production custody. Do not give testers this account address. Production still signs derived EOAs.',
    pin: {
      repo: 'https://github.com/MetaMask/delegation-framework',
      tag: TAG,
      commit: TAG_COMMIT,
      neverMain: true,
    },
    entryPointV07: ENTRY_POINT,
    deployer: ops.address,
    contracts: {
      simpleFactory: await simpleFactory.getAddress(),
      delegationManager: dmAddr,
      hybridDeleGatorImpl: hybridAddr,
      nativeTokenTransferAmountEnforcer: await amountEnforcer.getAddress(),
      timestampEnforcer: await timestampEnforcer.getAddress(),
      allowedTargetsEnforcer: await targetsEnforcer.getAddress(),
    },
    experimentAccount: {
      address: deployedAccount,
      predicted: predicted,
      owner: ops.address,
      note: 'One test HybridDeleGator. Ops EOA is owner. Not a user wallet.',
    },
    bytecode: log.bytecode,
    txs: {
      accountDeploy: deployRcpt.hash,
      addP256Key: addKeyRcpt.hash,
      caseA: caseA.tx,
      caseB: caseB.tx,
      disable: disableRcpt.hash,
      caseAAfterDisable: caseAAfter.tx,
      ownerBypass: ownerRcpt.hash,
    },
    measured: log.steps,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(json, null, 2)}\n`);
  const resultsPath = path.join(__dirname, '..', 'tasks', 'delegation-giwa-raw.json');
  fs.writeFileSync(resultsPath, `${JSON.stringify(log, null, 2)}\n`);
  console.log('wrote', outPath);
  console.log('CASE_A_OK', caseA.ok);
  console.log('CASE_B_REVERT_STRING', caseB.revert && caseB.revert.string);
  console.log('CASE_B_SELECTOR', caseB.revert && caseB.revert.selector);
  console.log('AFTER_DISABLE_CUSTOM', caseAAfter.revert && caseAAfter.revert.custom);
  console.log('ADDRESS_UNCHANGED', log.steps.addressUnchanged);
  console.log('OWNER_BYPASS', log.steps.ownerBypassOk);
}

main().catch((err) => {
  console.error(err && err.shortMessage ? err.shortMessage : err);
  if (err && err.data) console.error('data', err.data);
  process.exit(1);
});
