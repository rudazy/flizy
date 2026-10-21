import type { Metadata } from 'next';
import Link from 'next/link';
import { cache } from 'react';
import { loadReceipt } from '../../../lib/receipts.ts';
import { getWebChain, explorerTxUrl } from '../../../lib/dexServer';
import { pageMetadata } from '../../../lib/seo';

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

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await readReceipt(params.token);
  const base = pageMetadata({
    title: r ? `Paid ${r.amount} ${r.unit} on Flizy` : 'Receipt on Flizy',
    description: r ? `A payment of ${r.amount} ${r.unit} on ${r.network}, ${when(r.at)}.` : 'A payment receipt on Flizy.',
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
  const rows: Array<[string, string]> = [
    ['From', r.from],
    ['To', r.to],
    ...(r.note ? ([['For', r.note]] as Array<[string, string]>) : []),
    ['When', when(r.at)],
    ['Network', r.network],
  ];

  return (
    <div className="fade-up mx-auto max-w-md space-y-6">
      <section className="overflow-hidden rounded-[14px] border border-[#232323] bg-[#101010]">
        <div className="grid justify-items-center gap-2 px-5 pb-6 pt-8 text-center">
          <p className="m-0 font-sans text-[11px] uppercase tracking-[0.2em] text-sun">Payment confirmed</p>
          <p className="m-0 font-sans text-[44px] font-semibold leading-none tracking-wide text-paper">
            {r.amount} <span className="text-[22px] text-sun">{r.unit}</span>
          </p>
        </div>
        <dl className="m-0 grid gap-3 border-t border-[#1f1f1f] p-5 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-start justify-between gap-4">
              <dt className="text-muted">{label}</dt>
              <dd className="m-0 min-w-0 break-words text-right text-paper">{value}</dd>
            </div>
          ))}
        </dl>
        {r.txHash ? (
          <div className="border-t border-[#1f1f1f] p-5">
            <a
              href={explorerTxUrl(chain, r.txHash)}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm text-sun no-underline hover:opacity-80"
            >
              View the transaction
            </a>
          </div>
        ) : null}
      </section>
      <p className="text-center text-xs text-muted">
        Shared by someone in this payment. {chain.name} is a test network; these funds have no cash value.
      </p>
      <div className="flex justify-center">
        <Link href="/signup" className="btn btn-primary no-underline">
          Get paid on Flizy
        </Link>
      </div>
    </div>
  );
}
