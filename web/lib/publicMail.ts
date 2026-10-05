/**
 * Public mailboxes for flizy.app.
 *
 * One list, because the footer, the Terms, the Privacy policy, the account
 * security slide, and the Organization JSON-LD all name the same addresses.
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

export function publicMail(id: PublicMailId) {
  const box = PUBLIC_MAIL.find((item) => item.id === id);
  if (!box) throw new Error('Unknown public mailbox');
  return box;
}
