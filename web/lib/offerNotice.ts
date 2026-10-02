/**
 * The message an NFT's owner gets in chat when someone offers on it.
 *
 * Written to the outbox, which sends the body untouched, so there is no
 * {{cmd:}} marker: the command is written out in full, in the form both
 * WhatsApp and Telegram accept (Telegram takes the flizy prefix too), and the
 * NFT is named by its absolute URL (see web/lib/notifyChannels.ts). The command
 * is handled by handleAcceptOffer in lib/router.js. Same shape as
 * web/lib/payNotice.ts.
 */

import { displaySafeLabel } from './sanitize.ts';

export function formatOfferReceived(p: {
  amountEth: string;
  nftLabel: string;
  fromLabel: string;
  itemUrl: string;
}): string {
  // The offerer's name and the collection name are other people's text:
  // flattened, and braces removed so neither can read as a command marker.
  const from = displaySafeLabel(String(p.fromLabel || '').replace(/[{}]/g, '')) || 'someone';
  const nft = displaySafeLabel(String(p.nftLabel || '').replace(/[{}]/g, ''), 60) || 'your NFT';
  return [`New offer: ${p.amountEth} ETH for ${nft}, from ${from}`, '', `Use FLIZY ACCEPT OFFER to sell, or review it: ${p.itemUrl}`].join('\n');
}

/** The message a maker gets when the NFT's owner declines their offer. */
export function formatOfferDeclined(p: { amountEth: string; nftLabel: string; offersUrl: string }): string {
  const nft = displaySafeLabel(String(p.nftLabel || '').replace(/[{}]/g, ''), 60) || 'an NFT';
  return [
    `Your offer of ${p.amountEth} ETH for ${nft} was declined by the owner.`,
    '',
    `Your ETH is still held by the marketplace. Cancel the offer to get it back: ${p.offersUrl}`,
  ].join('\n');
}
