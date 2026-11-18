/**
 * Public mailboxes for flizy.app.
 *
 * One list. The site footer names contact. Terms names support. The Privacy
 * policy names privacy. The Organization JSON-LD publishes the whole list.
 * Each address has one job.
 */

export const PUBLIC_MAIL = [
  {
    id: 'support',
    address: 'support@flizy.app',
    label: 'Support',
    use: 'Account help, and email about your account.',
    contactType: 'customer support',
  },
  {
    id: 'admin',
    address: 'admin@flizy.app',
    label: 'Admin',
    use: 'Business communication.',
    contactType: 'business',
  },
  {
    id: 'contact',
    address: 'contact@flizy.app',
    label: 'Contact',
    use: 'General questions.',
    contactType: 'general',
  },
  {
    id: 'privacy',
    address: 'privacy@flizy.app',
    label: 'Privacy',
    use: 'Privacy and data requests, including account deletion.',
    contactType: 'privacy',
  },
] as const;

export type PublicMailId = (typeof PUBLIC_MAIL)[number]['id'];

/**
 * Where replies to an email about money moving go (web/lib/sendMail.ts). A
 * mailbox of its own, so it is not on the published list above.
 */
export const PAYMENTS_REPLY_TO = 'payments@flizy.app';

export function publicMail(id: PublicMailId) {
  const box = PUBLIC_MAIL.find((item) => item.id === id);
  if (!box) throw new Error('Unknown public mailbox');
  return box;
}
