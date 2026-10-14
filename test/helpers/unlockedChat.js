/**
 * Fixture state for a chat that is allowed to move money.
 *
 * lib/session.js sessionGate denies a chat whose account has no unlock PIN, and
 * a chat with no session row. A money-flow test that expects a send to go
 * through therefore seeds both: a PIN hash on the account and a live, unlocked
 * session row for the chat doing the sending.
 */

/** Any non-empty value: the gate only asks whether a PIN is set. */
const PIN_HASH_PRESENT = 'pin-hash-present';

/**
 * @param {string} accountId
 * @param {'whatsapp'|'telegram'} channel
 * @param {string} externalId
 * @param {number} [ttlMs] how long the unlock has left
 */
function unlockedSession(accountId, channel, externalId, ttlMs = 60 * 60 * 1000) {
  return {
    account_id: accountId,
    channel,
    external_id: externalId,
    is_locked: false,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };
}

module.exports = { PIN_HASH_PRESENT, unlockedSession };

/**
 * Unlock every linked chat in a seeded fake database, for flows where several
 * accounts act from chat (requests, pots, pay codes). Each account without a
 * PIN gets one, and each channel identity gets a live, unlocked session row.
 *
 * @param {{ accounts?: object[], channel_identities?: object[], sessions?: object[] }} tables
 */
function unlockAllChats(tables) {
  for (const account of tables.accounts || []) {
    if (!account.unlock_pin_hash) account.unlock_pin_hash = PIN_HASH_PRESENT;
  }
  tables.sessions = [
    ...(tables.sessions || []),
    ...(tables.channel_identities || []).map((i) => unlockedSession(i.account_id, i.channel, i.external_id)),
  ];
  return tables;
}

module.exports.unlockAllChats = unlockAllChats;
