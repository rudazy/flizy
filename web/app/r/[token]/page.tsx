import type { Metadata } from 'next';
import Link from 'next/link';
import { cache } from 'react';
import { loadReceipt } from '../../../lib/receipts.ts';
import { getWebChain, explorerTxUrl } from '../../../lib/dexServer';
import { pageMetadata } from '../../../lib/seo';
import { ethUsd } from '../../../lib/ethUsd.ts';
import { partyNote, receiptAmount, receiptHash, receiptUsd, receiptWhen } from '../../../lib/receiptView';
import { ReceiptCard } from '../../../components/ReceiptCard';

/**
 * /r/{token}: a payment one of its two parties chose to share.
 *
 * Read on the server from the token alone (web/lib/receipts.ts). Never indexed:
 * a receipt is shared by hand, not found by search.
 */

type Props = { params: { token: string } };

const readReceipt = cache(async (token: string) => {
  try {
    return await loadReceipt(token, getWebChain().name);
  } catch {
    return null;
  }
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await readReceipt(params.token);
  const base = pageMetadata({
    title: r ? `Paid ${r.amount} ${r.unit} on Flizy` : 'Receipt on Flizy',
    description: r ? `A payment of ${r.amount} ${r.unit} on ${r.network}, ${receiptWhen(r.at)}.` : 'A payment receipt on Flizy.',
    path: `/r/${params.token}`,
    noindex: true,
  });
  // pageMetadata names the site-wide card; a receipt shows its own, with the
  // amount on it (./opengraph-image.tsx). Set here because an explicit image
  // in metadata wins over the file-based one.
  const card = { url: `/r/${params.token}/opengraph-image`, width: 1200, height: 630, alt: 'Payment receipt on Flizy' };
  return {
    ...base,
    openGraph: { ...base.openGraph, images: [card] },
    twitter: { ...base.twitter, images: [card.url] },
  };
}

export default async function ReceiptPage({ params }: Props) {
  const r = await readReceipt(params.token);

  if (!r) {
    return (
      <div className="fade-up mx-auto max-w-md space-y-4">
        <h1 className="font-sans text-3xl tracking-wide text-paper">Receipt not found</h1>
        <p className="text-sm text-muted">This link does not open a payment. It may have been mistyped.</p>
        <Link href="/" className="text-sm text-sun no-underline hover:opacity-80">
          Home
        </Link>
      </div>
    );
  }

  const chain = getWebChain();
  // The dollar line for ETH needs the mainnet rate; tUSD is one to one and needs nothing.
  const usdPerEth = r.unit.toUpperCase() === 'ETH' ? await ethUsd().catch(() => null) : null;

  return (
    <ReceiptCard
      amount={receiptAmount(r.amount)}
      unit={r.unit}
      usd={receiptUsd(r.amount, r.unit, usdPerEth)}
      from={r.from}
      fromNote={partyNote(r.fromKind, 'from')}
      to={r.to}
      toNote={partyNote(r.toKind, 'to')}
      toIsFlizy={r.toKind === 'flizy'}
      note={r.note}
      when={receiptWhen(r.at)}
      network={r.network}
      txHash={r.txHash}
      hashLabel={r.txHash ? receiptHash(r.txHash) : null}
      explorerUrl={r.txHash ? explorerTxUrl(chain, r.txHash) : null}
      pagePath={`/r/${params.token}`}
      imagePath={`/r/${params.token}/image`}
    />
  );
}
