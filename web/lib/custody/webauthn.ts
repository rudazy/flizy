/**
 * WebAuthn passkeys as HybridDeleGator signers.
 *
 * A passkey made on flizy.app is added to the account as a P-256 key
 * (HybridDeleGator.addKey). When it later signs a delegation, the browser hands
 * back a WebAuthn assertion; this module turns that into the signature bytes
 * HybridDeleGator v1.3.0 checks (P256VerifierLib._decodeWebAuthnP256Signature):
 *
 *   abi.encode(bytes32 keyIdHash, uint256 r, uint256 s, bytes authenticatorData,
 *              bool requireUserVerification, string clientDataJSONPrefix,
 *              string clientDataJSONSuffix, uint256 responseTypeLocation)
 *
 * The contract rebuilds clientDataJSON as prefix + base64url(digest) + suffix,
 * so the challenge the browser signed must be exactly that digest. It also
 * refuses a high s (P256SCLVerifierLib), which authenticators do not avoid, so
 * s is folded into the low half here; (r, n - s) is the same signature.
 *
 * Server only. Signature checks use Node's crypto; nothing here is home-made
 * cryptography beyond reading the two integers out of a DER sequence.
 */

import { createHash, createPublicKey, verify, type KeyObject } from 'crypto';
import { ethers } from 'ethers';

/** The order of the P-256 group. */
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_N = P256_N / 2n;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

export type P256Key = { x: bigint; y: bigint };

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromB64url(text: string): Buffer {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  return Buffer.from(text, 'base64url');
}

/**
 * The P-256 point in a passkey's SubjectPublicKeyInfo, as the browser's
 * AuthenticatorAttestationResponse.getPublicKey() returns it. Anything that
 * is not an uncompressed P-256 key is refused.
 */
export function publicKeyFromSpki(spki: Uint8Array): P256Key {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
  } catch {
    throw new Error('the passkey public key could not be read');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('the passkey is not a P-256 key');
  }
  const jwk = key.export({ format: 'jwk' });
  if (!jwk.x || !jwk.y) throw new Error('the passkey public key could not be read');
  return { x: BigInt('0x' + fromB64url(jwk.x).toString('hex')), y: BigInt('0x' + fromB64url(jwk.y).toString('hex')) };
}

function spkiFor(key: P256Key): KeyObject {
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(ethers.getBytes(ethers.toBeHex(key.x, 32))), y: b64url(ethers.getBytes(ethers.toBeHex(key.y, 32))) },
    format: 'jwk',
  });
}

export type ClientData = { type: string; challenge: string; origin: string; crossOrigin?: boolean };

/**
 * The browser's clientDataJSON, checked against what this ceremony expects.
 * The challenge is compared as text; origin is the site's own origin.
 */
export function checkClientData(
  clientDataJSON: Uint8Array,
  expected: { type: 'webauthn.create' | 'webauthn.get'; challenge: string; origin: string }
): ClientData {
  let parsed: ClientData;
  try {
    parsed = JSON.parse(Buffer.from(clientDataJSON).toString('utf8'));
  } catch {
    throw new Error('the passkey response could not be read');
  }
  if (parsed?.type !== expected.type) throw new Error('the passkey response is for a different step');
  if (parsed.challenge !== expected.challenge) throw new Error('the passkey response is for a different request');
  if (parsed.origin !== expected.origin) throw new Error('the passkey response came from another site');
  if (parsed.crossOrigin === true) throw new Error('the passkey response came from another site');
  return parsed;
}

/** User present and user verified: the passkey asked for a face, finger or PIN. */
export function checkAuthenticatorData(authenticatorData: Uint8Array): void {
  if (authenticatorData.length < 37) throw new Error('the passkey response is too short');
  const flags = authenticatorData[32];
  if ((flags & FLAG_UP) === 0 || (flags & FLAG_UV) === 0) throw new Error('the passkey did not verify the person');
}

/** r and s from a DER ECDSA signature: SEQUENCE { INTEGER r, INTEGER s }. */
export function derToRs(der: Uint8Array): { r: bigint; s: bigint } {
  const b = Buffer.from(der);
  let i = 0;
  const fail = () => {
    throw new Error('the passkey signature could not be read');
  };
  if (b[i++] !== 0x30) fail();
  const seqLen = b[i++];
  if (seqLen === undefined || seqLen & 0x80 || seqLen !== b.length - 2) fail();
  const readInt = (): bigint => {
    if (b[i++] !== 0x02) fail();
    const len = b[i++];
    if (!len || len > 33 || i + len > b.length) fail();
    const value = BigInt('0x' + b.subarray(i, i + len).toString('hex'));
    i += len;
    return value;
  };
  const r = readInt();
  const s = readInt();
  if (i !== b.length || r <= 0n || r >= P256_N || s <= 0n || s >= P256_N) fail();
  return { r, s };
}

/** The low-s form the contract accepts. */
export function lowS(s: bigint): bigint {
  return s > HALF_N ? P256_N - s : s;
}

/** keccak256 of the key id, the slot HybridDeleGator stores the key under. */
export function keyIdHash(keyId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(keyId));
}

/**
 * Checks one assertion over `digest` against the stored key, and returns the
 * HybridDeleGator signature bytes for it. Throws on anything that would not
 * verify, so the caller never stores a signature the chain would refuse.
 */
export function encodeAssertion(p: {
  keyId: string;
  key: P256Key;
  digest: string;
  origin: string;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}): string {
  const challenge = b64url(ethers.getBytes(p.digest));
  checkClientData(p.clientDataJSON, { type: 'webauthn.get', challenge, origin: p.origin });
  checkAuthenticatorData(p.authenticatorData);

  const json = Buffer.from(p.clientDataJSON).toString('utf8');
  const marker = `"challenge":"${challenge}"`;
  const at = json.indexOf(marker);
  if (at < 0 || json.indexOf(marker, at + 1) >= 0) throw new Error('the passkey response is for a different request');
  const prefix = json.slice(0, at + '"challenge":"'.length);
  const suffix = json.slice(at + '"challenge":"'.length + challenge.length);
  const responseTypeLocation = json.indexOf('"type":"webauthn.get"');
  if (responseTypeLocation < 0) throw new Error('the passkey response is for a different step');

  // The same bytes the authenticator signed, checked with Node before the chain sees them.
  const signed = Buffer.concat([Buffer.from(p.authenticatorData), createHash('sha256').update(p.clientDataJSON).digest()]);
  if (!verify('sha256', signed, { key: spkiFor(p.key), dsaEncoding: 'der' }, Buffer.from(p.signature))) {
    throw new Error('the passkey signature does not match this key');
  }

  const { r, s } = derToRs(p.signature);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'uint256', 'bytes', 'bool', 'string', 'string', 'uint256'],
    [keyIdHash(p.keyId), r, lowS(s), p.authenticatorData, true, prefix, suffix, responseTypeLocation]
  );
}
