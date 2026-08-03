/**
 * Pending claims visible to a Flizy account (after platform or phone proof).
 * Pure orchestration on listIncomingPending + identities.
 */

const { listIdentitiesForAccount } = require('./identity');
const { listIncomingPending } = require('./claims');
const { claimRecipientLabel } = require('./claimRecipient');
const { claimHistoryCounterparty } = require('./claimHistoryLabel');

/**
 * @param {string} accountId
 * @returns {Promise<object[]>} claim rows
 */
async function listPendingClaimsForAccount(accountId) {
  if (!accountId) return [];
  const identities = await listIdentitiesForAccount(accountId);
  if (!identities.length) return [];

  // Phones on any identity + all platform rows for platform claims
  let waPhone = null;
  for (const row of identities) {
    if (row.phone_e164) {
      waPhone = row.phone_e164;
      break;
    }
  }

  const claims = await listIncomingPending({
    waSenderId: '',
    waPhone,
    identities: identities.map((i) => ({
      channel: i.channel,
      external_id: i.external_id,
      externalId: i.external_id,
      phone_e164: i.phone_e164,
    })),
  });

  return claims.filter((c) => String(c.status || '') === 'pending');
}

/**
 * Compact cards for dashboard / OAuth redirect.
 * @param {string} accountId
 */
async function listPendingClaimSummaries(accountId) {
  const rows = await listPendingClaimsForAccount(accountId);
  return rows.map((c) => ({
    id: c.id,
    amountEth: String(c.amount_eth),
    status: c.status,
    label: claimRecipientLabel(c),
    counterparty: claimHistoryCounterparty(c),
    createdAt: c.created_at,
    claimToken: c.claim_token || null,
  }));
}

module.exports = {
  listPendingClaimsForAccount,
  listPendingClaimSummaries,
};
