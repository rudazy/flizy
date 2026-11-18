'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { BUSINESS_FEE_SUMMARY, BUSINESS_TERM_HEADINGS } from '../lib/businessTerms.ts';
import { ClockIcon, LayersIcon, PeopleIcon, PercentIcon, PowerIcon, StoreIcon } from './ExploreIcons';

type BusinessView = {
  isBusiness: boolean;
  since: string | null;
  terms: { version: string; lines: string[] };
};

function day(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** One icon per terms line, in the order of BUSINESS_TERMS. */
const TERM_ICONS: ReactNode[] = [
  <PercentIcon key="fee" size={20} />,
  <PeopleIcon key="customers" size={20} />,
  <LayersIcon key="applies" size={20} />,
  <ClockIcon key="history" size={20} />,
  <PowerIcon key="off" size={20} />,
  <LayersIcon key="testnet" size={20} />,
];

const CARD = 'rounded-[10px] border border-chrome-line bg-[#0e0e0f]';

/**
 * Account > Business: what Business costs, the business terms in plain words,
 * and the switch (/api/account/business). Turning it on needs the terms
 * accepted; turning it off is asked once more, then done.
 */
export function BusinessAccountPanel() {
  const [view, setView] = useState<BusinessView | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    fetch('/api/account/business', { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) setMsg(body.error || 'Could not load Business. Try again shortly.');
        else setView(body);
      })
      .catch(() => live && setMsg('Could not load Business. Try again shortly.'));
    return () => {
      live = false;
    };
  }, []);

  async function save(on: boolean) {
    if (busy || !view) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/account/business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(on ? { on: true, termsVersion: view.terms.version } : { on: false }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Changed terms come back with the current ones, to read again.
        if (body.terms) setView({ ...view, terms: body.terms });
        setAgreed(false);
        setMsg(body.error || 'Could not save. Try again.');
        return;
      }
      setView(body);
      setAgreed(false);
      setConfirmOff(false);
    } catch {
      setMsg('Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const on = Boolean(view?.isBusiness);
  // Headings and icons name the lines only while they line up with them.
  const named = view ? view.terms.lines.length === BUSINESS_TERM_HEADINGS.length : false;

  return (
    <section role="tabpanel" className="flex grow flex-col gap-4 font-sans md:grow-0">
      <div className="relative overflow-hidden rounded-[10px] border border-sun/25 bg-[linear-gradient(135deg,#16140d_0%,#0e0d0a_60%,#0b0a09_100%)] p-5">
        <span
          aria-hidden
          className="pointer-events-none absolute -right-[440px] -top-6 h-[560px] w-[560px] rounded-full border border-sun/45 shadow-[0_0_48px_rgba(247,208,71,0.16)]"
        />
        <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_88%_35%,rgba(247,208,71,0.10),transparent_55%)]" />
        <div className="relative">
          <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.28em] text-sun">
            Business
            {on ? <span className="ml-2 rounded-[4px] border border-sun/40 bg-sun-wash px-2 py-0.5 text-[10px] tracking-normal">On</span> : null}
          </p>
          <h2 className="m-0 mt-2 text-[22px] font-semibold leading-tight tracking-wide text-paper sm:text-[28px]">Get paid for what you sell</h2>
        </div>
        <div className="relative flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="m-0 mt-2 text-sm leading-relaxed text-[#bdb6ab]">
              Accept payments from your customers with low fees and full transparency.
            </p>
            <div className="mt-4 grid max-w-[320px] grid-cols-2 rounded-[8px] border border-chrome-line bg-[#0d0c0a]">
              <div className="px-4 py-3">
                <p className="m-0 text-xs text-[#bdb6ab]">Flizy fee</p>
                <p className="m-0 mt-1 font-sans text-2xl font-semibold text-sun">{BUSINESS_FEE_SUMMARY.fee}</p>
              </div>
              <div className="border-l border-chrome-line px-4 py-3">
                <p className="m-0 text-xs text-[#bdb6ab]">Minimum fee</p>
                <p className="m-0 mt-1 font-sans text-2xl font-semibold text-paper">{BUSINESS_FEE_SUMMARY.minimum}</p>
              </div>
            </div>
          </div>
          <div
            aria-hidden
            className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-[18px] border border-sun/70 bg-[linear-gradient(145deg,#2a2410,#100e08)] text-sun shadow-[0_0_32px_rgba(247,208,71,0.28)] sm:h-[96px] sm:w-[96px]"
          >
            <StoreIcon size={40} strokeWidth={2} />
          </div>
        </div>
      </div>

      {!view ? (
        <div className={`${CARD} p-4`}>
          <p className="m-0 text-sm text-muted">{msg || 'Loading...'}</p>
        </div>
      ) : (
        <>
          <div className={`${CARD} p-4`}>
            <h3 className="m-0 font-sans text-lg font-semibold tracking-wide text-paper">{on ? 'Your business terms' : 'Business terms'}</h3>
            <ul className="m-0 mt-3 grid list-none divide-y divide-chrome-line border-t border-chrome-line p-0">
              {view.terms.lines.map((line, i) => (
                <li key={line} className="flex items-start gap-4 py-3">
                  <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] border border-sun/15 bg-sun-wash text-sun">
                    {named ? TERM_ICONS[i] : <span className="h-1.5 w-1.5 rounded-full bg-sun" />}
                  </span>
                  <span className="min-w-0">
                    {named ? <span className="block text-sm font-semibold text-paper">{BUSINESS_TERM_HEADINGS[i]}</span> : null}
                    <span className={`block text-[13px] leading-relaxed ${named ? 'text-[#bdb6ab]' : 'text-paper'}`}>{line}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className={`${CARD} grid gap-4 p-4`}>
            {on ? (
              <>
                <p className="m-0 text-sm text-paper">Business is on{view.since ? ` since ${day(view.since)}` : ''}.</p>
                {confirmOff ? (
                  <div className="grid gap-3">
                    <p className="m-0 text-sm text-paper">Turn Business off? Payments you receive after this are not charged the business fee.</p>
                    <div className="grid grid-cols-2 gap-3">
                      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmOff(false)}>
                        Keep it on
                      </button>
                      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save(false)}>
                        {busy ? 'Saving...' : 'Turn off'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="btn btn-ghost w-full" disabled={busy} onClick={() => setConfirmOff(true)}>
                    Turn Business off
                  </button>
                )}
              </>
            ) : (
              <>
                <label className="flex cursor-pointer items-center gap-3 text-sm text-paper">
                  <input
                    type="checkbox"
                    className="h-[20px] w-[20px] shrink-0 accent-sun"
                    checked={agreed}
                    disabled={busy}
                    onChange={(e) => setAgreed(e.target.checked)}
                  />
                  <span>I have read these terms and agree to them.</span>
                </label>
                <button type="button" className="btn btn-primary w-full" disabled={busy || !agreed} onClick={() => void save(true)}>
                  {busy ? 'Saving...' : 'Turn Business on'}
                </button>
              </>
            )}
          </div>
        </>
      )}
      {view && msg ? <div className="alert alert-error text-sm">{msg}</div> : null}
    </section>
  );
}
