require('dotenv').config();
const crypto = require('crypto');
const { ethers } = require('ethers');

const RPC = 'https://sepolia-rpc.giwa.io';
const PROBE = '0x3c490e8D049f14d7Ee51dc2cC6Ca7B5EB3418F19';
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const N_DIV_2 = N / 2n;

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function parsePt(spki) {
  const buf = Buffer.from(spki);
  const point = buf.subarray(buf.length - 65);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('SPKI did not end in uncompressed P-256 point');
  }
  return {
    x: BigInt('0x' + point.subarray(1, 33).toString('hex')),
    y: BigInt('0x' + point.subarray(33, 65).toString('hex')),
  };
}

function ieeeToRS(sig) {
  let r = BigInt('0x' + sig.subarray(0, 32).toString('hex'));
  let s = BigInt('0x' + sig.subarray(32, 64).toString('hex'));
  if (s > N_DIV_2) s = N - s;
  return { r, s };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, 91342);
  const probe = new ethers.Contract(
    PROBE,
    [
      'function verifySignature(bytes32,uint256,uint256,uint256,uint256) view returns (bool)',
      'function hybridWebAuthnBranch(bytes32,bytes,uint256,uint256) view returns (bool)',
    ],
    provider
  );

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pt = parsePt(publicKey.export({ type: 'spki', format: 'der' }));
  const challengeHash = ethers.keccak256(ethers.toUtf8Bytes('flizy-p256-e2e-' + Date.now()));
  const rpIdHash = crypto.createHash('sha256').update('flizy.app').digest();
  const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
  const prefix = '{"type":"webauthn.get","challenge":"';
  const suffix = '","origin":"https://flizy.app","crossOrigin":false}';
  const challengeB64 = b64url(Buffer.from(ethers.getBytes(challengeHash)));
  const clientDataJSON = prefix + challengeB64 + suffix;
  const signedPreimage = Buffer.concat([
    authenticatorData,
    crypto.createHash('sha256').update(clientDataJSON, 'utf8').digest(),
  ]);
  const sig = crypto.sign('sha256', signedPreimage, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const { r, s } = ieeeToRS(sig);
  const keyIdHash = ethers.keccak256(ethers.toUtf8Bytes('flizy-measure-1'));
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const types = ['bytes32', 'uint256', 'uint256', 'bytes', 'bool', 'string', 'string', 'uint256'];
  const encoded = coder.encode(types, [keyIdHash, r, s, authenticatorData, true, prefix, suffix, 1n]);
  const encodedB = coder.encode(types, [keyIdHash, r, s ^ 1n, authenticatorData, true, prefix, suffix, 1n]);

  const A = await probe.hybridWebAuthnBranch(challengeHash, encoded, pt.x, pt.y);
  const B = await probe.hybridWebAuthnBranch(challengeHash, encodedB, pt.x, pt.y);

  const dataA = probe.interface.encodeFunctionData('hybridWebAuthnBranch', [
    challengeHash,
    encoded,
    pt.x,
    pt.y,
  ]);
  const dataB = probe.interface.encodeFunctionData('hybridWebAuthnBranch', [
    challengeHash,
    encodedB,
    pt.x,
    pt.y,
  ]);
  const gasA = await provider.estimateGas({ to: PROBE, data: dataA });
  const gasB = await provider.estimateGas({ to: PROBE, data: dataB });

  const msgHash = '0x' + crypto.createHash('sha256').update(signedPreimage).digest('hex');
  const p256A = await probe.verifySignature(msgHash, r, s, pt.x, pt.y);
  const p256B = await probe.verifySignature(msgHash, r, s ^ 1n, pt.x, pt.y);
  const dataP = probe.interface.encodeFunctionData('verifySignature', [msgHash, r, s, pt.x, pt.y]);
  const gasP = await provider.estimateGas({ to: PROBE, data: dataP });

  const callA = await provider.call({ to: PROBE, data: dataA });
  const callB = await provider.call({ to: PROBE, data: dataB });

  console.log(
    JSON.stringify(
      {
        probe: PROBE,
        hybridA: A,
        hybridB: B,
        callA,
        callB,
        p256A,
        p256B,
        gasHybridA: gasA.toString(),
        gasHybridB: gasB.toString(),
        gasP256ViaProbe: gasP.toString(),
        s_le_n_div_2: s <= N_DIV_2,
        clientDataJSON,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
