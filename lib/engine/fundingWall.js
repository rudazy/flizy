/**
 * The one funding wall.
 *
 * Fourteen places used to tell a user they could not afford something, each
 * with its own wording and each ending on a bare hex address. An address is
 * not an instruction: the user reads it at the moment of highest intent and
 * has nowhere to go. They render here instead, so the copy and the way out of
 * it exist once.
 *
 * The engine has no `ctx` and cannot know which dialect each channel reads —
 * that is `lib/commands/render.js`, via a `{{cmd:...}}` marker. So this
 * emits only the channel-neutral half, ending on the fund page. The chat
 * adapter recognises `FUND_REASON` on the result and appends the command half.
 */

const { config } = require('../config');

/** Set as `reason` on any refusal built here. The chat adapter keys off it. */
const FUND_REASON = 'insufficient_funds';

/** The one primary fund path. The Fund slide holds address, copy button, steps. */
const FUND_URL = `${config.siteUrl}/dashboard/wallet?s=fund`;

/**
 * @param {{
 *   kind: 'gas'|'native'|'token',
 *   address: string,
 *   asset?: string,
 *   have?: string|null,
 *   need?: string|null,
 * }} args
 *   `have` and `need` are already-formatted amounts without a unit. Only the
 *   plan stage has them; the execute paths hold raw wei and omit both.
 * @returns {string}
 */
function fundingWallText({ kind, address, asset = 'ETH', have = null, need = null }) {
  const lines = [];

  if (kind === 'gas') {
    lines.push('Need a little ETH in your Flizy wallet for gas.');
  } else if (kind === 'native') {
    lines.push('Not enough ETH in your Flizy wallet (amount + gas).');
    if (have != null && need != null) {
      lines.push(`Have ${have} ETH · Need ~${need} ETH + gas`);
    }
  } else {
    lines.push(`Not enough ${asset} in your Flizy wallet.`);
    if (have != null && need != null) {
      lines.push(`Have ${have} ${asset} · Need ${need} ${asset}`);
    }
  }

  lines.push('', `Your wallet: ${address}`, `Add funds: ${FUND_URL}`);
  return lines.join('\n');
}

/**
 * Not a funding wall: the user does not own the NFT they are trying to move.
 * Adding ETH does not fix that, so this carries no fund route and no
 * `FUND_REASON` — it shows the wallet only so they can see which one was read.
 *
 * @param {{ line: string, address: string }} args
 * @returns {string}
 */
function notHeldText({ line, address }) {
  return [`You do not hold ${line}.`, `Your wallet: ${address}`].join('\n');
}

module.exports = {
  FUND_REASON,
  FUND_URL,
  fundingWallText,
  notHeldText,
};
