/**
 * Minimal Privy wallet API client for the headless spike runner.
 *
 * App-level calls use Basic auth (PRIVY_APP_ID:PRIVY_APP_SECRET). Calls that
 * act on a wallet owned by an authorization key also carry
 * privy-authorization-signature: ECDSA P-256 / SHA-256 over the RFC 8785
 * canonical JSON of {version, method, url, body, headers}, base64 DER.
 * The authorization private key is base64 PKCS#8 in PRIVY_AUTH_KEY and is
 * never logged or returned.
 */

const crypto = require('crypto');

const API = 'https://api.privy.io';
const TIMEOUT_MS = 30_000;

/** RFC 8785 JSON canonicalization for the value shapes these requests use. */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

/** New P-256 authorization keypair: base64 PKCS#8 private, base64 SPKI DER public. */
function generateAuthKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function publicKeyOf(privateKeyB64) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
}

function config() {
  const appId = process.env.PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) throw new Error('PRIVY_APP_ID and PRIVY_APP_SECRET are required in .env.spike');
  return { appId, basic: Buffer.from(`${appId}:${secret}`).toString('base64') };
}

function authorizationSignature(url, body, appId, privateKeyB64) {
  const payload = { version: 1, method: 'POST', url, body, headers: { 'privy-app-id': appId } };
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64.replace(/^wallet-auth:/, ''), 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign('sha256', Buffer.from(canonicalize(payload)), key).toString('base64');
}

async function post(path, body, { sign = false } = {}) {
  const { appId, basic } = config();
  const url = `${API}${path}`;
  const headers = {
    authorization: `Basic ${basic}`,
    'content-type': 'application/json',
    'privy-app-id': appId,
  };
  if (sign) {
    if (!process.env.PRIVY_AUTH_KEY) throw new Error('PRIVY_AUTH_KEY is missing');
    headers['privy-authorization-signature'] = authorizationSignature(url, body, appId, process.env.PRIVY_AUTH_KEY);
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON error body
  }
  if (!res.ok) {
    const detail = (json && (json.error || json.message)) || text.slice(0, 300);
    throw new Error(`Privy ${path} HTTP ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return json;
}

async function createWallet(publicKeyB64) {
  const w = await post('/v1/wallets', { chain_type: 'ethereum', owner: { public_key: publicKeyB64 } });
  if (!w || typeof w.id !== 'string' || typeof w.address !== 'string') throw new Error('unexpected wallet response');
  return { id: w.id, address: w.address, ownerId: w.owner_id || null };
}

function signatureOf(resp) {
  const sig = resp && resp.data && resp.data.signature;
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error('unexpected signature response');
  return sig;
}

async function personalSign(walletId, message) {
  const body = { method: 'personal_sign', params: { message, encoding: 'utf-8' } };
  return signatureOf(await post(`/v1/wallets/${encodeURIComponent(walletId)}/rpc`, body, { sign: true }));
}

/**
 * typedData is eth_signTypedData_v4 JSON (domain, types incl. EIP712Domain,
 * primaryType, message). The chain is bound by domain.chainId, which every
 * payload here sets to 91342; the caller recovers and checks each signature.
 */
async function signTypedData(walletId, typedData) {
  const body = {
    method: 'eth_signTypedData_v4',
    params: {
      typed_data: {
        domain: typedData.domain,
        types: typedData.types,
        primary_type: typedData.primaryType,
        message: typedData.message,
      },
    },
  };
  return signatureOf(await post(`/v1/wallets/${encodeURIComponent(walletId)}/rpc`, body, { sign: true }));
}

module.exports = { generateAuthKey, publicKeyOf, createWallet, personalSign, signTypedData };
