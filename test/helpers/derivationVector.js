/**
 * One pinned derivation vector, shared by the bot-side and web-side tests.
 *
 * lib/agentWallet.js and web/lib/agentWallet.ts are two copies of the same
 * derivation (the web bundle cannot import root lib/). This vector is what
 * keeps them honest: both test files assert the same account id under the same
 * secret yields VECTOR_V2_ADDRESS. If someone edits one copy, the other test
 * fails immediately instead of the drift being discovered by funds landing on
 * an address the other half of the system cannot see.
 *
 * The secret here is a test fixture. It is not, and must never be, a real
 * WALLET_DERIVATION_SECRET.
 */

const VECTOR_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const VECTOR_SECRET = 'flizy-test-vector-secret-do-not-use-in-production-0123456789';

/** v2: HMAC-SHA256(secret, "flizy:agent:v2:" + id) then keccak256 */
const VECTOR_V2_ADDRESS = '0x7178120b8cD4546191809c61b7ee31111b97b353';

/** v1 legacy: keccak256(utf8("flizy:agent:v1:" + id)), no secret */
const VECTOR_V1_ADDRESS = '0x906Fa8a04e28cC00cc2344c5598f0b1c1807fF84';

module.exports = {
  VECTOR_ACCOUNT_ID,
  VECTOR_SECRET,
  VECTOR_V2_ADDRESS,
  VECTOR_V1_ADDRESS,
};
