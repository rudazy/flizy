/**
 * Agent wallet derivation for the site (self-contained for Vercel / web package).
 *
 * This is a deliberate mirror of lib/agentWallet.js. The web bundle cannot
 * import monorepo root lib/ (webpack cannot resolve root deps on Vercel), so the
 * derivation exists twice and the two copies must stay byte for byte equivalent.
 * If they drift, an account resolves to one address in chat and a different one
 * on the site, and funds land where the other half cannot see them.
 *
 * test/agentWallet.test.js and test/webAgentWallet.test.js pin the same vector
 * on both sides so drift fails the suite.
 *
 * v2 keys the derivation with a server-only secret. Under v1 the account id was
 * the only input, and that id also left the server in API responses, so anyone
 * who saw one could rebuild the key offline.
 */

import { createHmac } from 'crypto';
import { ethers } from 'ethers';

const AGENT_LABEL_V2 = 'flizy:agent:v2:';
const AGENT_LABEL_V1 = 'flizy:agent:v1:';
const MIN_SECRET_LENGTH = 32;

/**
 * Server-only secret that turns an account id into key material.
 * Missing or weak secret is fatal: never fall back to the v1 derivation.
 */
export function requireDerivationSecret(): string {
  const secret = process.env.WALLET_DERIVATION_SECRET || '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `WALLET_DERIVATION_SECRET is required and must be at least ${MIN_SECRET_LENGTH} characters. ` +
        'Agent wallet keys cannot be derived without it. It must be the same value on every ' +
        'process (bot and site) or accounts resolve to different addresses.'
    );
  }
  return secret;
}

/**
 * Agent private key for an account (server-only, never returned to the browser).
 */
export function deriveAgentPrivateKey(accountId: string): string {
  const secret = requireDerivationSecret();
  const mac = createHmac('sha256', secret).update(`${AGENT_LABEL_V2}${accountId}`).digest();
  return ethers.keccak256(mac);
}

export function deriveAgentWallet(accountId: string): ethers.Wallet {
  return new ethers.Wallet(deriveAgentPrivateKey(accountId));
}

export function deriveAgentAddress(accountId: string): string {
  return deriveAgentWallet(accountId).address;
}

/**
 * LEGACY v1 address: account id only, no secret.
 *
 * Read-only use. It exists so a stored v1 pointer can be recognised and moved
 * forward to the v2 address. Never derive a live signer from v1.
 */
export function deriveLegacyAddressV1(accountId: string): string {
  const material = ethers.keccak256(ethers.toUtf8Bytes(`${AGENT_LABEL_V1}${accountId}`));
  return new ethers.Wallet(material).address;
}
