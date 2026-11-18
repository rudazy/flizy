import { parseEmail } from './email.ts';

/**
 * An email address handed from page to page after the # of a link, which a
 * browser never sends to a server. The claim email's link carries #to=; the
 * claim page passes it to sign-up, sign-in and the add-email form as #email=,
 * so the recipient starts with the address the payment was sent to filled in.
 * Only a well-formed address is taken. It fills a field, nothing more: the
 * address is still verified by a code before anything is claimed.
 */
export function emailFromHash(hash: string, key: 'to' | 'email'): string {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  return parseEmail(params.get(key) || '');
}

/** The #email= suffix for a link to sign-up or sign-in, or nothing. */
export function emailHashSuffix(email: string): string {
  const parsed = parseEmail(email);
  return parsed ? `#email=${encodeURIComponent(parsed)}` : '';
}
