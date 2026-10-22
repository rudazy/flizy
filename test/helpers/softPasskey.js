/**
 * A software stand-in for a phone's passkey: a P-256 key that answers
 * navigator.credentials.get() the way an authenticator does. authenticatorData
 * is rpIdHash, flags, counter; clientDataJSON is the browser's field order;
 * the signature is DER over authenticatorData || sha256(clientDataJSON).
 *
 * Test and local-fork use only.
 */

const crypto = require('crypto');

const ORIGIN = 'https://flizy.app';
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function createSoftPasskey({ rpId = 'flizy.app', flags = 0x05 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = {
    x: BigInt('0x' + Buffer.from(jwk.x, 'base64url').toString('hex')),
    y: BigInt('0x' + Buffer.from(jwk.y, 'base64url').toString('hex')),
  };
  const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
  let counter = 0;

  /** Answer a get() for a 32-byte challenge given as 0x hex. */
  function assert(challengeHex, { origin = ORIGIN, type = 'webauthn.get', authFlags = flags } = {}) {
    counter += 1;
    const challenge = Buffer.from(challengeHex.replace(/^0x/, ''), 'hex').toString('base64url');
    const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
    const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([authFlags]), Buffer.from([0, 0, 0, counter])]);
    const signed = Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
    const signature = crypto.sign('sha256', signed, { key: privateKey, dsaEncoding: 'der' });
    return { authenticatorData, clientDataJSON, signature };
  }

  return { spki, point, assert };
}

/** The same signature with s replaced by n - s, still valid, always "high" when the original was low. */
function flipS(derSig) {
  const b = Buffer.from(derSig);
  const rLen = b[3];
  const r = b.subarray(4, 4 + rLen);
  const sLen = b[5 + rLen];
  const s = BigInt('0x' + b.subarray(6 + rLen, 6 + rLen + sLen).toString('hex'));
  const flipped = P256_N - s;
  let hex = flipped.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let sBytes = Buffer.from(hex, 'hex');
  if (sBytes[0] & 0x80) sBytes = Buffer.concat([Buffer.from([0]), sBytes]);
  const body = Buffer.concat([Buffer.from([0x02, r.length]), r, Buffer.from([0x02, sBytes.length]), sBytes]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

module.exports = { createSoftPasskey, flipS, ORIGIN, P256_N };
