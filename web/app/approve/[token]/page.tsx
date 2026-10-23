import type { Metadata } from 'next';
import { pageMetadata } from '../../../lib/seo';
import { ApprovePayment } from '../../../components/ApprovePayment';

/**
 * /approve/{token}: approve one chat payment over the daily passkey limit.
 *
 * The token only finds the approval. What it pays, and to whom, is read from
 * the server for the signed-in account (ApprovePayment), never from the URL.
 * Never indexed.
 */

type Props = { params: { token: string } };

export const metadata: Metadata = pageMetadata({
  title: 'Approve a payment on Flizy',
  description: 'Approve one payment with your passkey.',
  path: '/approve',
  noindex: true,
});

export default function ApprovePage({ params }: Props) {
  return <ApprovePayment token={params.token} />;
}
