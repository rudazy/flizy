/**
 * The message a payee gets when a site pay reaches them.
 *
 * Same wording as chat's received notice (formatReceivedNotice in
 * lib/notify.js), with one difference: the site writes to the outbox, which
 * sends the body untouched, so there is no {{cmd:}} marker. The wallet is named
 * by its absolute URL instead (see web/lib/notifyChannels.ts).
 */

import { displaySafeLabel } from './sanitize.ts';

export function formatPaymentReceived(p: {
  amount: string;
  asset: string;
  fromLabel: string;
  walletUrl: string;
}): string {
  // The payer's name is another user's text: flattened, and braces removed so
  // it can never read as a command marker.
  const from = displaySafeLabel(String(p.fromLabel || '').replace(/[{}]/g, '')) || 'someone';
  return [
    `You received ${p.amount} ${p.asset} from ${from}.`,
    '',
    `It is in your Flizy wallet: ${p.walletUrl}`,
  ].join('\n');
}

/** How a payer is named to the payee: @username, else display name. */
export function payerLabel(payer: { username?: string | null; display_name?: string | null } | null): string {
  if (payer?.username) return `@${payer.username}`;
  return String(payer?.display_name || '');
}
