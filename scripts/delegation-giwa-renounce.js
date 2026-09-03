/**
 * GIWA Sepolia: add a P-256 key, issue a bounded delegation signed by
 * that key, renounce the EOA owner, then prove the delegate still
 * executes inside the bound and the former owner cannot execute outside
 * it.
 *
 * Research only. Does not touch production accounts, lib/, web/, or chat
 * clients. Reuses the existing experiment account. Pin: v1.3.0.
 * Set DELEGATION_FRAMEWORK_ROOT to a local clone of that tag.
 *
 * The P-256 private key is written only to a gitignored local store.
 * It is never logged and never written to deployments/.
 *
 * Do not re-run casually: renounce is one-way on this account.
 *
 * Run (Windows CMD):
 *   node scripts\delegation-giwa-renounce.js
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
const EXPLORER = 'https://sepolia-explorer.giwa.io';
const KEY_ID = 'root-p256';
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const P256_N_DIV_2 = P256_N / 2n;
const EIP1271_MAGIC = '0x1626ba7e';
const SIG_VALIDATION_FAILED = '0xffffffff';

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
const INVALID_1271_ERR = ethers.id('InvalidERC1271Signature()').slice(0, 10);
const FAILED_OP_ERR = ethers.id('FailedOp(uint256,string)').slice(0, 10);

const CAP_WEI = ethers.parseEther('0.005');
const IN_BOUNDS_WEI = ethers.parseEther('0.001');
const OUT_BOUNDS_WEI = ethers.parseEther('0.01');
const DELEGATE_FUND_WEI = ethers.parseEther('0.015');
const ACCOUNT_MIN_WEI = ethers.parseEther('0.02');

function art(solFile, name) {
  const p = path.join(FRAMEWORK_ROOT, 'out', solFile, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function keccakHex(hex) {
  const h = String(hex || '0x');
  if (h.includes('_') || h.includes('$')) return 'unlinked-artifact';
  return ethers.keccak256(h === '0x' || h === '0x0' ? '0x' : h);
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
      /* leave null */
    }
  }
  if (out.selector === DISABLED_ERR) out.custom = 'CannotUseADisabledDelegation()';
  if (out.selector === INVALID_1271_ERR) out.custom = 'InvalidERC1271Signature()';
  if (out.selector === FAILED_OP_ERR) {
    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint256', 'string'],
        '0x' + hex.slice(10)
      );
      out.custom = `FailedOp(${decoded[0]}, "${decoded[1]}")`;
      out.string = decoded[1];
    } catch {
      out.custom = 'FailedOp(uint256,string)';
    }
  }
  return out;
}

function parsePt(spkiDer) {
  const buf = Buffer.from(spkiDer);
  const point = buf.subarray(buf.length - 65);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('SPKI did not end in uncompressed P-256 point');
  }
  return {
    x: BigInt('0x' + point.subarray(1, 33).toString('hex')),
    y: BigInt('0x' + point.subarray(33, 65).toString('hex')),
  };
}

function loadOrCreateP256(storePath) {
  if (fs.existsSync(storePath)) {
    const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (saved.keyId !== KEY_ID || !saved.pem) {
      throw new Error('tasks P-256 store is not the expected key');
    }
    const privateKey = crypto.createPrivateKey(saved.pem);
    const publicKey = crypto.createPublicKey(privateKey);
    const pt = parsePt(publicKey.export({ type: 'spki', format: 'der' }));
    if (pt.x.toString() !== saved.x || pt.y.toString() !== saved.y) {
      throw new Error('tasks P-256 store does not match derived public point');
    }
    return { privateKey, x: pt.x, y: pt.y, keyId: KEY_ID, reused: true };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const pt = parsePt(publicKey.export({ type: 'spki', format: 'der' }));
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(
    storePath,
    `${JSON.stringify(
      {
        note: 'LOCAL ONLY. P-256 PKCS8 for the GIWA HybridDeleGator experiment. Never commit. Never log.',
        account: '0x71055FF6aD1a792FD1b213BD00ac50ba4B40bda1',
        keyId: KEY_ID,
        x: pt.x.toString(),
        y: pt.y.toString(),
        pem,
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return { privateKey, x: pt.x, y: pt.y, keyId: KEY_ID, reused: false };
}

function signRawP256(privateKey, hash32, keyId) {
  const hashBytes = Buffer.from(ethers.getBytes(hash32));
  const sig = crypto.sign('sha256', hashBytes, {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  let r = BigInt('0x' + sig.subarray(0, 32).toString('hex'));
  let s = BigInt('0x' + sig.subarray(32, 64).toString('hex'));
  if (s > P256_N_DIV_2) s = P256_N - s;
  const keyIdHash = ethers.keccak256(ethers.toUtf8Bytes(keyId));
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'uint256'],
    [keyIdHash, r, s]
  );
}

async function main() {
  if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY missing from env');
  const depPath = path.join(__dirname, '..', 'deployments', 'giwa-sepolia-delegation.json');
  const dep = JSON.parse(fs.readFileSync(depPath, 'utf8'));
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`wrong chain ${net.chainId}`);
  const ops = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  if (ops.address.toLowerCase() !== String(dep.deployer).toLowerCase()) {
    throw new Error('ops key is not the recorded deployer');
  }

  const accountAddr = dep.experimentAccount.address;
  const dmAddr = dep.contracts.delegationManager;
  const hybridArt = art('HybridDeleGator.sol', 'HybridDeleGator');
  const dmArt = art('DelegationManager.sol', 'DelegationManager');
  const account = new ethers.Contract(accountAddr, hybridArt.abi, ops);
  const dm = new ethers.Contract(dmAddr, dmArt.abi, ops);

  const ownerNow = await account.owner();
  if (ownerNow === ethers.ZeroAddress) {
    throw new Error('owner already zero; this script is one-shot');
  }
  if (ownerNow.toLowerCase() !== ops.address.toLowerCase()) {
    throw new Error(`owner is ${ownerNow}, not ops`);
  }

  const log = {
    chainId: CHAIN_ID,
    account: accountAddr,
    ops: ops.address,
    steps: {},
  };

  const p256Path = path.join(__dirname, '..', 'tasks', 'delegation-giwa-p256.json');
  const p256 = loadOrCreateP256(p256Path);
  log.steps.p256KeyId = KEY_ID;
  log.steps.p256ReusedStore = p256.reused;
  log.steps.p256X = '0x' + p256.x.toString(16).padStart(64, '0');
  log.steps.p256Y = '0x' + p256.y.toString(16).padStart(64, '0');

  const ep = new ethers.Contract(
    ENTRY_POINT,
    [
      'function getNonce(address sender, uint192 key) view returns (uint256)',
      'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary) payable',
    ],
    ops
  );

  async function signAndSendUserOp(callData) {
    const nonce = await ep.getNonce(accountAddr, 0);
    const fee = await provider.getFeeData();
    const maxPrio = fee.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');
    const maxFee = fee.maxFeePerGas || maxPrio * 2n;
    const userOp = {
      sender: accountAddr,
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
        verifyingContract: accountAddr,
      },
      structHash
    );
    userOp.signature = ops.signingKey.sign(typed).serialized;
    const tx = await ep.handleOps([userOp], ops.address);
    const rcpt = await tx.wait();
    if (rcpt.status !== 1) throw new Error('handleOps failed');
    return { rcpt, userOp, typed };
  }

  async function formerOwnerExecute(valueWei) {
    const nonce = await ep.getNonce(accountAddr, 0);
    const fee = await provider.getFeeData();
    const maxPrio = fee.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');
    const maxFee = fee.maxFeePerGas || maxPrio * 2n;
    const callData = account.interface.encodeFunctionData('execute((address,uint256,bytes))', [
      { target: sink.address, value: valueWei, callData: '0x' },
    ]);
    const userOp = {
      sender: accountAddr,
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
        verifyingContract: accountAddr,
      },
      structHash
    );
    userOp.signature = ops.signingKey.sign(typed).serialized;
    const data = ep.interface.encodeFunctionData('handleOps', [[userOp], ops.address]);
    const sinkBefore = await provider.getBalance(sink.address);
    const accBefore = await provider.getBalance(accountAddr);
    try {
      const tx = await ops.sendTransaction({
        to: ENTRY_POINT,
        data,
        gasLimit: 800_000n,
      });
      const rcpt = await tx.wait();
      return {
        ok: rcpt.status === 1,
        tx: rcpt.hash,
        status: Number(rcpt.status),
        gasUsed: rcpt.gasUsed.toString(),
        sinkDelta: ((await provider.getBalance(sink.address)) - sinkBefore).toString(),
        accountDelta: ((await provider.getBalance(accountAddr)) - accBefore).toString(),
        revert: rcpt.status === 1 ? null : { short: 'mined status 0', raw: null },
      };
    } catch (err) {
      return {
        ok: false,
        tx: err.receipt?.hash || null,
        status: err.receipt ? Number(err.receipt.status) : null,
        gasUsed: err.receipt ? err.receipt.gasUsed.toString() : null,
        sinkDelta: '0',
        accountDelta: '0',
        revert: decodeRevert(err),
      };
    }
  }

  const existing = await account.getKey(KEY_ID);
  const existingX = existing.x_ ?? existing[0];
  const existingY = existing.y_ ?? existing[1];
  let addKeyTx = 'already-on-chain';
  if (existingX === 0n && existingY === 0n) {
    const addKeyData = account.interface.encodeFunctionData('addKey', [
      KEY_ID,
      p256.x,
      p256.y,
    ]);
    const execAdd = account.interface.encodeFunctionData('execute((address,uint256,bytes))', [
      { target: accountAddr, value: 0, callData: addKeyData },
    ]);
    const sent = await signAndSendUserOp(execAdd);
    addKeyTx = sent.rcpt.hash;
    console.log('addKey', addKeyTx);
  } else {
    if (existingX !== p256.x || existingY !== p256.y) {
      throw new Error('on-chain root-p256 does not match stored key');
    }
    console.log('root-p256 already on chain');
  }
  log.steps.addKeyTx = addKeyTx;

  const onchainKey = await account.getKey(KEY_ID);
  const onchainX = onchainKey.x_ ?? onchainKey[0];
  const onchainY = onchainKey.y_ ?? onchainKey[1];
  if (onchainX !== p256.x || onchainY !== p256.y) {
    throw new Error('addKey did not land the stored public point');
  }

  const probeHash = ethers.keccak256(ethers.toUtf8Bytes('renounce-preflight'));
  const probeSig = signRawP256(p256.privateKey, probeHash, KEY_ID);
  if (ethers.dataLength(probeSig) !== 96) {
    throw new Error(`raw P-256 sig length ${ethers.dataLength(probeSig)} not 96`);
  }
  const probeMagic = await account.isValidSignature(probeHash, probeSig);
  log.steps.preflightP256Magic = probeMagic;
  console.log('preflight P-256 isValidSignature', probeMagic);
  if (probeMagic.toLowerCase() !== EIP1271_MAGIC) {
    throw new Error('P-256 ERC-1271 preflight failed; not renouncing');
  }

  const delegate = ethers.Wallet.createRandom().connect(provider);
  const sink = ethers.Wallet.createRandom().connect(provider);
  log.steps.delegate = delegate.address;
  log.steps.sink = sink.address;

  const accBal = await provider.getBalance(accountAddr);
  if (accBal < ACCOUNT_MIN_WEI) {
    const fund = await ops.sendTransaction({
      to: accountAddr,
      value: ACCOUNT_MIN_WEI - accBal,
    });
    await fund.wait();
  }
  const fundDel = await ops.sendTransaction({
    to: delegate.address,
    value: DELEGATE_FUND_WEI,
  });
  await fundDel.wait();

  const now = BigInt(Math.floor(Date.now() / 1000));
  const tsTerms = ethers.concat([
    ethers.toBeHex(0n, 16),
    ethers.toBeHex(now + 60n * 60n * 24n, 16),
  ]);
  const amountTerms = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [CAP_WEI]);
  const caveats = [
    {
      enforcer: dep.contracts.nativeTokenTransferAmountEnforcer,
      terms: amountTerms,
      args: '0x',
    },
    {
      enforcer: dep.contracts.timestampEnforcer,
      terms: tsTerms,
      args: '0x',
    },
    {
      enforcer: dep.contracts.allowedTargetsEnforcer,
      terms: '0x' + sink.address.toLowerCase().replace('0x', ''),
      args: '0x',
    },
  ];
  const delegation = {
    delegate: delegate.address,
    delegator: accountAddr,
    authority: ROOT_AUTHORITY,
    caveats,
    salt: 2n,
    signature: '0x',
  };
  const delTyped = eip712Hash(
    {
      name: 'DelegationManager',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: dmAddr,
    },
    delegationStructHash(delegation)
  );
  delegation.signature = signRawP256(p256.privateKey, delTyped, KEY_ID);
  log.steps.delegationHashTyped = delTyped;
  log.steps.delegationSigBytes = ethers.dataLength(delegation.signature);

  const delMagic = await account.isValidSignature(delTyped, delegation.signature);
  log.steps.preflightDelegationMagic = delMagic;
  console.log('preflight delegation isValidSignature', delMagic);
  if (delMagic.toLowerCase() !== EIP1271_MAGIC) {
    throw new Error('P-256 delegation ERC-1271 preflight failed; not renouncing');
  }

  const ownerEcdsaSig = ops.signingKey.sign(delTyped).serialized;
  const ownerMagicBefore = await account.isValidSignature(delTyped, ownerEcdsaSig);
  log.steps.preflightOwnerEcdsaMagic = ownerMagicBefore;
  console.log('preflight owner ECDSA isValidSignature', ownerMagicBefore);

  const addrBefore = ethers.getAddress(accountAddr);
  const keccakBefore = keccakHex(await provider.getCode(accountAddr));
  const ownerBefore = await account.owner();
  const keysBefore = (await account.getKeyIdHashesCount()).toString();
  log.steps.addressBeforeRenounce = addrBefore;
  log.steps.codeKeccakBeforeRenounce = keccakBefore;
  log.steps.ownerBeforeRenounce = ownerBefore;
  log.steps.keyCountBeforeRenounce = keysBefore;

  const renounceData = account.interface.encodeFunctionData('renounceOwnership', []);
  const execRenounce = account.interface.encodeFunctionData('execute((address,uint256,bytes))', [
    { target: accountAddr, value: 0, callData: renounceData },
  ]);
  const renounceSent = await signAndSendUserOp(execRenounce);
  log.steps.renounceTx = renounceSent.rcpt.hash;
  log.steps.renounceBlock = renounceSent.rcpt.blockNumber;
  console.log('renounce', renounceSent.rcpt.hash);

  const addrAfter = ethers.getAddress(accountAddr);
  const keccakAfter = keccakHex(await provider.getCode(accountAddr));
  const ownerAfter = await account.owner();
  const keysAfter = (await account.getKeyIdHashesCount()).toString();
  log.steps.addressAfterRenounce = addrAfter;
  log.steps.codeKeccakAfterRenounce = keccakAfter;
  log.steps.ownerAfterRenounce = ownerAfter;
  log.steps.keyCountAfterRenounce = keysAfter;
  log.steps.addressUnchanged = addrBefore.toLowerCase() === addrAfter.toLowerCase();
  log.steps.codeUnchanged = keccakBefore === keccakAfter;
  console.log(
    'after renounce owner',
    ownerAfter,
    'addressUnchanged',
    log.steps.addressUnchanged
  );
  if (!log.steps.addressUnchanged) {
    throw new Error('HEADLINE: account address moved on renounce');
  }
  if (ownerAfter !== ethers.ZeroAddress) {
    throw new Error(`owner after renounce is ${ownerAfter}, not zero`);
  }

  const p256MagicAfter = await account.isValidSignature(delTyped, delegation.signature);
  const ownerMagicAfter = await account.isValidSignature(delTyped, ownerEcdsaSig);
  log.steps.p256MagicAfterRenounce = p256MagicAfter;
  log.steps.ownerEcdsaMagicAfterRenounce = ownerMagicAfter;
  console.log('after renounce P-256 magic', p256MagicAfter, 'owner ECDSA', ownerMagicAfter);
  if (p256MagicAfter.toLowerCase() !== EIP1271_MAGIC) {
    throw new Error('P-256 ERC-1271 died on renounce; delegate would be dead');
  }

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

  async function redeem(valueWei, label) {
    const exec = encodeSingle(sink.address, valueWei, '0x');
    const ctx = ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)[]',
      ],
      [[delegationTuple(delegation)]]
    );
    const dmAsDelegate = dm.connect(delegate);
    const sinkBefore = await provider.getBalance(sink.address);
    const accBefore = await provider.getBalance(accountAddr);
    try {
      const tx = await dmAsDelegate.redeemDelegations(
        [ctx],
        [ethers.ZeroHash],
        [exec]
      );
      const rcpt = await tx.wait();
      return {
        label,
        ok: rcpt.status === 1,
        tx: rcpt.hash,
        block: rcpt.blockNumber,
        from: rcpt.from,
        to: rcpt.to,
        gasUsed: rcpt.gasUsed.toString(),
        sinkDelta: ((await provider.getBalance(sink.address)) - sinkBefore).toString(),
        accountDelta: ((await provider.getBalance(accountAddr)) - accBefore).toString(),
        revert: null,
      };
    } catch (err) {
      return {
        label,
        ok: false,
        tx: err.receipt?.hash || null,
        gasUsed: null,
        sinkDelta: '0',
        accountDelta: '0',
        revert: decodeRevert(err),
      };
    }
  }

  const caseA = await redeem(IN_BOUNDS_WEI, 'inBounds_afterRenounce');
  log.steps.caseA = caseA;
  console.log(
    'in-bounds after renounce',
    caseA.ok,
    caseA.tx,
    caseA.revert && (caseA.revert.string || caseA.revert.custom)
  );

  const caseB = await redeem(OUT_BOUNDS_WEI, 'outOfBounds_afterRenounce');
  log.steps.caseB = caseB;
  console.log(
    'out-of-bounds after renounce',
    caseB.ok,
    caseB.revert && (caseB.revert.string || caseB.revert.custom)
  );

  const ownerTry = await formerOwnerExecute(IN_BOUNDS_WEI);
  log.steps.formerOwnerExecute = ownerTry;
  console.log(
    'former owner execute',
    ownerTry.ok,
    ownerTry.tx,
    ownerTry.revert && (ownerTry.revert.string || ownerTry.revert.custom || ownerTry.revert.short)
  );

  const resultsPath = path.join(__dirname, '..', 'tasks', 'delegation-giwa-renounce-raw.json');
  fs.writeFileSync(resultsPath, `${JSON.stringify(log, null, 2)}\n`);

  dep.experimentAccount.owner = ownerAfter;
  dep.experimentAccount.note =
    'One test HybridDeleGator. Owner was renounced to address(0). P-256 is the on-chain root. Not a user wallet. Not production custody.';
  dep.renounce = {
    measuredAt: '2026-09-03',
    keyId: KEY_ID,
    addKeyTx,
    renounceTx: log.steps.renounceTx,
    renounceBlock: log.steps.renounceBlock,
    addressBefore: addrBefore,
    addressAfter: addrAfter,
    addressUnchanged: log.steps.addressUnchanged,
    codeKeccakBefore: keccakBefore,
    codeKeccakAfter: keccakAfter,
    ownerBefore,
    ownerAfter,
    keyCountBefore: keysBefore,
    keyCountAfter: keysAfter,
    p256MagicAfterRenounce: p256MagicAfter,
    ownerEcdsaMagicAfterRenounce: ownerMagicAfter,
    delegate: delegate.address,
    sink: sink.address,
    inBounds: caseA,
    outOfBounds: caseB,
    formerOwnerExecute: ownerTry,
  };
  fs.writeFileSync(depPath, `${JSON.stringify(dep, null, 2)}\n`);

  console.log('CASE_A_OK', caseA.ok);
  console.log('CASE_B_STRING', caseB.revert && caseB.revert.string);
  console.log('FORMER_OWNER_OK', ownerTry.ok);
  console.log('OWNER_AFTER', ownerAfter);
  console.log('ADDRESS_UNCHANGED', log.steps.addressUnchanged);
  console.log('P256_MAGIC_AFTER', p256MagicAfter);
  console.log('OWNER_ECDSA_MAGIC_AFTER', ownerMagicAfter);
}

main().catch((err) => {
  console.error(err && err.shortMessage ? err.shortMessage : err);
  if (err && err.data) console.error('data', err.data);
  process.exit(1);
});
