/**
 * Human history labels for claims.
 *
 * The rail (GitHub pay / Phone / X pay / Discord pay) is the send path.
 * The peer is the display handle or phone digits — never the only key for matching.
 */

const { recipientFromRow, channelLabel } = require('./claimRecipient');
const { displaySafeLabel } = require('./sanitize');

/**
 * @param {object} row claims row (needs recipient columns)
 * @returns {{ rail: string, peer: string|null }}
 */
function claimHistoryPeer(row) {
  const r = recipientFromRow(row);
  if (!r) {
    return { rail: 'Claim', peer: null };
  }
  if (r.kind === 'phone') {
    return {
      rail: 'Phone pay',
      peer: r.phone ? `+${r.phone}` : null,
    };
  }
  const where = channelLabel(r.channel);
  // Short product rails: "GitHub pay", "X pay", "Discord pay"
  const rail =
    r.channel === 'github'
      ? 'GitHub pay'
      : r.channel === 'x'
        ? 'X pay'
        : r.channel === 'discord'
          ? 'Discord pay'
          : `${where} pay`;
  if (r.displayHandle) {
    return { rail, peer: `@${displaySafeLabel(r.displayHandle)}` };
  }
  return { rail, peer: `${where} user ${displaySafeLabel(r.externalId)}` };
}

/**
 * One-line history desk label.
 *
 * @param {object} row claims row
 * @param {{ role: 'sender'|'receiver', status?: string }} opts
 */
function formatClaimHistoryLabel(row, opts) {
  const status = String(opts.status || row.status || 'pending');
  const amount = String(row.amount_eth ?? '').trim() || '?';
  const { rail, peer } = claimHistoryPeer(row);
  const peerBit = peer ? ` · ${peer}` : '';

  if (opts.role === 'sender') {
    if (status === 'cancelled') {
      return `${rail}${peerBit} · cancelled · ${amount} ETH`;
    }
    if (status === 'claimed') {
      return `${rail}${peerBit} · claimed · ${amount} ETH`;
    }
    if (status === 'processing') {
      return `${rail}${peerBit} · processing · ${amount} ETH`;
    }
    return `${rail}${peerBit} · held · ${amount} ETH`;
  }

  // Receiver
  if (status === 'claimed') {
    return `Received · ${rail}${peerBit} · ${amount} ETH`;
  }
  return `Incoming · ${rail}${peerBit} · ${amount} ETH (${status})`;
}

/**
 * Counterparty column for the history UI.
 * @param {object} row
 */
function claimHistoryCounterparty(row) {
  const { rail, peer } = claimHistoryPeer(row);
  return peer ? `${rail} ${peer}` : rail;
}

module.exports = {
  claimHistoryPeer,
  formatClaimHistoryLabel,
  claimHistoryCounterparty,
};
