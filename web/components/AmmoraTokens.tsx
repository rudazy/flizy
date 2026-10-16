'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

/**
 * Explore > Tokens: Ammora launches, in their own section below Flizy's
 * tokens. Shown only when NEXT_PUBLIC_AMMORA_ENABLED is "true"; otherwise this
 * renders nothing and makes no request.
 *
 * These are third-party launches: never called Verified or Graduated. Only a
 * token Ammora would route right now gets a Trade button. Names and symbols
 * arrive sanitized from the server (web/lib/ammora/catalog.ts) and React
 * renders them as text.
 */

type AmmoraTokenView = {
  address: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  label: string;
};

export function ammoraUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AMMORA_ENABLED === 'true';
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

export function AmmoraTokens() {
  const enabled = ammoraUiEnabled();
  const [tokens, setTokens] = useState<AmmoraTokenView[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/ammora/tokens', { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || body.unavailable) {
          setUnavailable(true);
          setTokens([]);
        } else {
          setTokens(Array.isArray(body.tokens) ? body.tokens : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUnavailable(true);
          setTokens([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <section className="mt-[10px] grid gap-[8px]" aria-labelledby="ammora-launches">
      <div>
        <h2 id="ammora-launches" className="m-0 font-sans text-[15px] font-bold text-white">
          Ammora launches
        </h2>
        <p className="m-0 mt-[4px] font-sans text-[10.4px] text-[#a9a9a9]">
          Tokens launched on Ammora, a separate venue on GIWA. Flizy has not reviewed them. Check the contract before you trade.
        </p>
      </div>
      {tokens === null ? <p className="m-0 font-sans text-[10px] text-[#a9a9a9]">Loading...</p> : null}
      {tokens !== null && tokens.length === 0 ? (
        <p className="m-0 rounded-[6px] border border-[#1f1f22] bg-[#0c0c0d] px-[14px] py-[14px] font-sans text-[10px] text-[#a9a9a9]">
          {unavailable ? 'Ammora launches are unavailable right now.' : 'No Ammora launches yet.'}
        </p>
      ) : null}
      <ul className="m-0 grid list-none gap-[5px] p-0">
        {(tokens || []).map((t) => (
          <li
            key={t.address}
            className="flex items-center gap-[10px] rounded-[6px] border border-[#1f1f22] bg-[#0c0c0d] px-[12px] py-[10px]"
          >
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate font-sans text-[11px] font-semibold text-white">
                {t.symbol} <span className="font-mono text-[9.5px] font-normal text-[#a9a9a9]">{short(t.address)}</span>
              </p>
              <p className="m-0 mt-[2px] truncate font-sans text-[9.6px] text-[#a9a9a9]">
                {t.name ? `${t.name}. ` : ''}Ammora launch, {t.status}
              </p>
            </div>
            {t.tradable ? (
              <Link
                href={`/dashboard/swap?venue=ammora&token=${t.address}`}
                className="hit-y-44 shrink-0 rounded-[5px] border border-[#3a3b40] px-[10px] py-[5px] font-sans text-[9.6px] text-[#ececec] no-underline hover:text-white"
                aria-label={`Trade ${t.label}`}
              >
                Trade
              </Link>
            ) : (
              <span className="shrink-0 font-sans text-[9.6px] text-[#8a8a8f]">Not tradable yet</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
