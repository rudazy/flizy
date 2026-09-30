'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  TOKEN_FILTERS,
  TOKEN_VIEWS,
  filterHelper,
  isTokenFilter,
  tokensForFilter,
  type DiscoveryToken,
  type TokenFilterId,
  type TokenViewId,
} from '../lib/tokenDiscovery';
import { formatEthDisplay, formatPct } from '../lib/tokenFormat';
import { CopySetupPanel } from './CopySetupPanel';
import { VerifiedMark } from './VerifiedMark';

/**
 * Tokens: find a token, or open copy trade.
 * A row is the way into the token page. Copy trade is not a row.
 */
export function ExploreTokens() {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() || '';
  const view: TokenViewId = search.get('view') === 'copy' ? 'copy' : 'discover';
  const requested = search.get('f') || '';
  const filter: TokenFilterId = isTokenFilter(requested) ? requested : 'trending';
  const [tokens, setTokens] = useState<DiscoveryToken[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (view !== 'discover') return;
    let cancelled = false;
    (async () => {
      setError('');
      try {
        const res = await fetch('/api/tokens');
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(body.error || 'Could not load tokens.');
        else setTokens(Array.isArray(body.tokens) ? body.tokens : []);
      } catch {
        if (!cancelled) setError('Could not load tokens.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view]);

  function setQuery(nextView: TokenViewId, nextFilter: TokenFilterId) {
    const params = new URLSearchParams(search.toString());
    params.set('s', 'tokens');
    if (nextView === 'discover') params.delete('view');
    else params.set('view', nextView);
    if (nextFilter === 'trending') params.delete('f');
    else params.set('f', nextFilter);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const listed = tokensForFilter(filter, tokens || []);

  return (
    <div className="grid w-full max-w-lg gap-4">
      <div className="flex gap-2" role="tablist" aria-label="Token section">
        {TOKEN_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={view === item.id}
            onClick={() => setQuery(item.id, filter)}
            className={`min-h-11 rounded-md border px-3 font-sans text-sm tracking-wide ${
              view === item.id ? 'border-lime/40 bg-lime/10 text-lime' : 'border-border text-muted'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {view === 'copy' ? <CopySetupPanel kind="trade" /> : null}

      {view === 'discover' ? (
        <>
          <div
            className="flex gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            role="tablist"
            aria-label="Token filters"
          >
            {TOKEN_FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={filter === item.id}
                onClick={() => setQuery('discover', item.id)}
                className={`min-h-11 shrink-0 rounded-md border px-3 font-sans text-xs tracking-wide ${
                  filter === item.id ? 'border-lime/40 bg-lime/10 text-lime' : 'border-border text-muted'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="m-0 text-xs leading-relaxed text-muted">{filterHelper(filter)}</p>
          {error ? <p className="alert alert-error">{error}</p> : null}
          {tokens === null && !error ? <p className="text-sm text-muted">Loading...</p> : null}
          {tokens && listed.tokens.length === 0 ? (
            <section className="card p-4">
              <p className="m-0 text-sm text-muted">{listed.empty}</p>
            </section>
          ) : null}
          {listed.tokens.length > 0 ? (
            <div className="grid gap-2">
              {listed.tokens.map((token) => {
                const change = formatPct(token.change1hPct);
                return (
                  <Link
                    key={token.symbol}
                    href={`/dashboard/explore/tokens/${token.symbol.toLowerCase()}`}
                    className="card flex items-center justify-between gap-3 p-4 no-underline"
                  >
                    <div className="min-w-0">
                      <p className="m-0 flex items-center gap-1.5 font-sans text-sm tracking-wide text-paper">
                        <span>{token.symbol}</span>
                        {token.verified ? <VerifiedMark /> : null}
                      </p>
                      <p className="m-0 text-xs text-muted">{token.name}</p>
                    </div>
                    <div className="text-right">
                      <p className="m-0 font-mono text-sm text-paper">
                        {formatEthDisplay(token.priceEth) || 'unavailable'} ETH
                      </p>
                      <p className={`m-0 font-mono text-xs ${change && change.startsWith('+') ? 'text-lime' : 'text-muted'}`}>
                        {change ? `${change} 1h` : '1h unavailable'}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
