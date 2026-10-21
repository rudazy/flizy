/**
 * The message a payee gets when a site pay reaches them.
 *
 * Same wording as chat's received notice (formatReceivedNotice in
 * lib/notify.js), with one difference: the site writes to the outbox, which
 * sends the body untouched, so there is no {{cmd:}} marker. The wallet is named
 * by its absolute URL instead (see web/lib/notifyChannels.ts).
 */

import { displaySafeLabel } from './sanitize.ts';
import { symbolLabel } from './listedTokens.ts';

export function formatPaymentReceived(p: {
  amount: string;
  asset: string;
  /** What it was for, already cleaned by cleanPayNote; flattened again here. */
  note?: string | null;
  fromLabel: string;
  walletUrl: string;
}): string {
  // The payer's name is another user's text: flattened, and braces removed so
  // it can never read as a command marker.
  const from = displaySafeLabel(String(p.fromLabel || '').replace(/[{}]/g, '')) || 'someone';
  const note = p.note ? displaySafeLabel(String(p.note).replace(/[{}]/g, ''), 80) : '';
  return [
    `You received ${p.amount} ${symbolLabel(p.asset)} from ${from}.`,
    ...(note ? [`For: ${note}`] : []),
    '',
    `It is in your Flizy wallet: ${p.walletUrl}`,
  ].join('\n');
}

/** How a payer is named to the payee: @username, else display name. */
export function payerLabel(payer: { username?: string | null; display_name?: string | null } | null): string {
  if (payer?.username) return `@${payer.username}`;
  return String(payer?.display_name || '');
}
