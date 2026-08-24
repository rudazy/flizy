/**
 * GIWA Sepolia P-256 / WebAuthn measurement helper.
 * Read-only against 0x100 unless --deploy is passed (not used by default).
 */
const crypto = require('crypto');
const { ethers } = require('ethers');

const RPC = 'https://sepolia-rpc.giwa.io';
const PRECOMPILE = '0x0000000000000000000000000000000000000100';
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const N_DIV_2 = N / 2n;

const EIP7951_VALID =
  '0xbb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023' +
  '2ba3a8be6b94d5ec80a6d9d1190a436effe50d85a1eee859b8cc6af9bd5c2e18' +
  '4cd60b855d442f5b3c7b11eb6c4e0ae7525fe710fab9aa7c77a67f79e6fadd76' +
  '2927b10512bae3eddcfe467828128bad2903269919f7086069c8c4df6c732838' +
  'c7787964eaac00e5921fb1498a60f4606766b3d9685001558d1a974e7341513e';

function rpc(method, params) {
  return fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json());
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function parseUncompressedPoint(spkiDer) {
  const buf = Buffer.from(spkiDer);
  const idx = buf.lastIndexOf(0x04);
  if (idx < 0 || buf.length - idx < 65) throw new Error('no uncompressed point');
  const x = buf.subarray(idx + 1, idx + 33);
  const y = buf.subarray(idx + 33, idx + 65);
  return { x: BigInt('0x' + x.toString('hex')), y: BigInt('0x' + y.toString('hex')) };
}

function lowS(r, s) {
  let ss = s;
  if (ss > N_DIV_2) ss = N - ss;
  return { r, s: ss };
}

function ieeeToRS(sig) {
  if (sig.length !== 64) throw new Error('expected 64-byte ieee-p1363');
  const r = BigInt('0x' + sig.subarray(0, 32).toString('hex'));
  const s = BigInt('0x' + sig.subarray(32, 64).toString('hex'));
  return lowS(r, s);
}

function pad32(n) {
  return ethers.toBeHex(n, 32);
}

function p256Input(hash, r, s, x, y) {
  return ethers.concat([hash, pad32(r), pad32(s), pad32(x), pad32(y)]);
}

async function callPrecompile(data) {
  const call = await rpc('eth_call', [{ to: PRECOMPILE, data }, 'latest']);
  const trace = await rpc('debug_traceCall', [
    { to: PRECOMPILE, data },
    'latest',
    { tracer: 'callTracer' },
  ]);
  const est = await rpc('eth_estimateGas', [{ to: PRECOMPILE, data }]);
  return { call, trace, est };
}

function makeWebAuthn(privateKey, publicPoint, challengeHash) {
  const rpIdHash = crypto.createHash('sha256').update('flizy.app').digest();
  const flags = Buffer.from([0x05]);
  const counter = Buffer.from([0, 0, 0, 1]);
  const authenticatorData = Buffer.concat([rpIdHash, flags, counter]);

  const prefix = '{"type":"webauthn.get","challenge":"';
  const suffix = '","origin":"https://flizy.app","crossOrigin":false}';
  const challengeB64 = b64url(Buffer.from(ethers.getBytes(challengeHash)));
  const clientDataJSON = prefix + challengeB64 + suffix;
  const clientDataJSONHash = crypto.createHash('sha256').update(clientDataJSON, 'utf8').digest();
  const signedPreimage = Buffer.concat([authenticatorData, clientDataJSONHash]);
  const messageHash = crypto.createHash('sha256').update(signedPreimage).digest();

  const sig = crypto.sign('sha256', signedPreimage, {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  const { r, s } = ieeeToRS(sig);

  const keyId = 'flizy-measure-1';
  const keyIdHash = ethers.keccak256(ethers.toUtf8Bytes(keyId));
  const requireUV = true;
  const responseTypeLocation = 1n;

  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'uint256', 'bytes', 'bool', 'string', 'string', 'uint256'],
    [
      keyIdHash,
      r,
      s,
      authenticatorData,
      requireUV,
      prefix,
      suffix,
      responseTypeLocation,
    ]
  );

  return {
    keyId,
    keyIdHash,
    r,
    s,
    x: publicPoint.x,
    y: publicPoint.y,
    authenticatorData: '0x' + authenticatorData.toString('hex'),
    clientDataJSON,
    prefix,
    suffix,
    responseTypeLocation: Number(responseTypeLocation),
    messageHash: '0x' + messageHash.toString('hex'),
    encoded,
  };
}

async function main() {
  const out = {};

  const code = await rpc('eth_getCode', [PRECOMPILE, 'latest']);
  out.getCode_0x100 = code;

  const validVec = await callPrecompile(EIP7951_VALID);
  out.eip7951_valid = validVec;

  const invalidInput = EIP7951_VALID.slice(0, 66) + '3' + EIP7951_VALID.slice(67);
  const invalidVec = await callPrecompile(invalidInput);
  out.eip7951_invalid_one_byte_r = {
    inputHead: invalidInput.slice(0, 68),
    ...invalidVec,
  };

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const point = parseUncompressedPoint(spki);
  const challengeHash = ethers.keccak256(ethers.toUtf8Bytes('flizy-p256-measure-' + Date.now()));
  const assertion = makeWebAuthn(privateKey, point, challengeHash);
  out.webauthn = {
    challengeHash,
    keyId: assertion.keyId,
    keyIdHash: assertion.keyIdHash,
    x: assertion.x.toString(16),
    y: assertion.y.toString(16),
    r: assertion.r.toString(16),
    s: assertion.s.toString(16),
    s_le_n_div_2: assertion.s <= N_DIV_2,
    authenticatorData: assertion.authenticatorData,
    clientDataJSON: assertion.clientDataJSON,
    messageHash: assertion.messageHash,
    encodedLen: (assertion.encoded.length - 2) / 2,
  };

  const webInput = p256Input(
    assertion.messageHash,
    assertion.r,
    assertion.s,
    assertion.x,
    assertion.y
  );
  out.webauthn_precompile_A = await callPrecompile(webInput);

  const sCorrupt = assertion.s ^ 1n;
  const webInputB = p256Input(
    assertion.messageHash,
    assertion.r,
    sCorrupt,
    assertion.x,
    assertion.y
  );
  out.webauthn_precompile_B = await callPrecompile(webInputB);

  const addrs = {
    HybridDeleGatorImpl: '0x48dBe696A4D990079e039489bA2053B36E8FFEC4',
    DelegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
    SimpleFactory: '0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c',
  };
  out.canonical_v1_3_0 = {};
  for (const [name, addr] of Object.entries(addrs)) {
    const c = await rpc('eth_getCode', [addr, 'latest']);
    const res = c.result || '0x';
    out.canonical_v1_3_0[name] = {
      address: addr,
      bytecodeBytes: res === '0x' ? 0 : (res.length - 2) / 2,
    };
  }

  console.log(JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
