import type { Metadata } from 'next';
import { ApprovalForm } from './ApprovalForm';

/**
 * The page a chat approval link opens (lib/chatApprovals.js). The PIN for a
 * chat unlock, a payment that needs it, or an unlink is typed here and never
 * in the chat.
 *
 * The title is generic and nothing about the request is in the metadata, so a
 * link preview shows nothing about the payment. Not indexed.
 */
export const metadata: Metadata = {
  title: 'Approve on Flizy',
  robots: { index: false, follow: false },
};

export default function ApprovalPage({ params }: { params: { token: string } }) {
  return <ApprovalForm token={params.token} />;
}
