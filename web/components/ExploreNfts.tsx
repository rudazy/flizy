'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AppSection } from './AppSection';
import { useDashboard } from './DashboardProvider';
import { NFT_VIEWS, type NftViewId } from '../lib/tokenDiscovery';
import { CopySetupPanel } from './CopySetupPanel';

type Listed = { ticker: string; address: string };

/**
 * NFT discovery, plus copy mint.
 *
 * The warning stays on the listed view. A collection someone does not hold is
 * still listed, because the address on this page is what a copy has to match.
 */
export function ExploreNfts() {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() || '';
  const view: NftViewId = search.get('view') === 'mint' ? 'mint' : 'listed';
  const { holdings, explorerBase } = useDashboard();
  const held = new Set(
    (holdings?.holdings?.nfts || [])
      .filter((nft) => Number(nft.balance) > 0)
      .map((nft) => nft.address.toLowerCase())
  );
  const [collections, setCollections] = useState<Listed[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (view !== 'listed') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/nfts');
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(body.error || 'Could not load collections.');
        else setCollections(Array.isArray(body.collections) ? body.collections : []);
      } catch {
        if (!cancelled) setError('Could not load collections.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view]);

  function setView(next: NftViewId) {
    const params = new URLSearchParams(search.toString());
    params.set('s', 'nfts');
    if (next === 'listed') params.delete('view');
    else params.set('view', next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div className="grid w-full max-w-lg gap-4">
      <div className="flex gap-2" role="tablist" aria-label="NFT section">
        {NFT_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={view === item.id}
            onClick={() => setView(item.id)}
            className={`min-h-11 rounded-md border px-3 font-sans text-sm tracking-wide ${
              view === item.id ? 'border-lime/40 bg-lime/10 text-lime' : 'border-border text-muted'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {view === 'mint' ? <CopySetupPanel kind="mint" /> : null}

      {view === 'listed' ? (
        <>
          <AppSection title="Before you mint" badge="Read this" badgeTone="gold">
            <div className="grid gap-2 text-sm text-muted">
              <p className="m-0">
                Anyone can deploy a collection using the same name and the same
                artwork as a real one. The name proves nothing. The contract address
                is the only thing that does.
              </p>
              <p className="m-0">
                The collections below are the ones Flizy lists. If you find one
                anywhere else, compare its contract address against this page before
                you mint or buy. If it does not match, it is a different collection
                whatever it is called.
              </p>
              <p className="m-0">
                Flizy will never ask you to approve a contract in a direct message.
              </p>
            </div>
          </AppSection>

          <AppSection title="Listed by Flizy" helper="Minting is a chat command for now">
            {error ? <p className="alert alert-error">{error}</p> : null}
            {collections === null && !error ? <p className="text-sm text-muted">Loading...</p> : null}
            {collections && collections.length === 0 ? (
              <p className="text-sm text-muted">No collections are listed on this network yet.</p>
            ) : null}
            {collections && collections.length > 0 ? (
              <div className="grid gap-2">
                {collections.map((nft) => (
                  <div
                    key={nft.address}
                    className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2 last:border-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="m-0 font-sans text-sm tracking-wide text-paper">{nft.ticker}</p>
                      <p className="m-0 break-all font-mono text-xs text-muted">{nft.address}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted">
                        {held.has(nft.address.toLowerCase()) ? 'You hold this' : 'Not held'}
                      </span>
                      {explorerBase ? (
                        <a
                          className="btn btn-ghost text-sm no-underline"
                          href={`${explorerBase}/address/${nft.address}`}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Contract
                        </a>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </AppSection>
        </>
      ) : null}
    </div>
  );
}
