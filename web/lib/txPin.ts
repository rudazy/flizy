/**
 * Whether a transaction asks for the PIN: a payment, a pay with ETH, a mint, a
 * marketplace buy, sale or offer, a limit order.
 *
 * Off on the GIWA Sepolia testnet. Every transaction is a plain Confirm, and
 * the session is the gate: the site sign-in, and in chat the PIN unlock, which
 * stays on (lib/session.js). The daily ETH limit, the trusted list, the
 * first-payment warning and the confirm step all still apply.
 *
 * Turn this back on before mainnet by setting `required: true`. Nothing in
 * the app changes it at runtime; the test suite turns it on to keep the PIN
 * path tested. Mirror of txPin in lib/tiers.js, which the chat bot reads;
 * test/txPin.test.js keeps the two equal.
 *
 * Imports nothing, so client components can read it without pulling in the
 * server's PIN check.
 */
export const txPin = { required: false };
