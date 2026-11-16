'use client';

import { useEffect, useState } from 'react';
import { AppSection } from './AppSection';

type BusinessView = {
  isBusiness: boolean;
  since: string | null;
  terms: { version: string; lines: string[] };
};

function day(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Account > Business: the business terms in plain words, and the switch
 * (/api/account/business). Turning it on needs the terms accepted; turning it
 * off is asked once more, then done.
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

  return (
    <AppSection
      title="Business"
      helper="For people who sell. Your customers pay no fee; Flizy keeps 1% of what you receive."
      badge={on ? 'On' : undefined}
      badgeTone="gold"
    >
      {!view ? (
        <p className="mt-4 text-sm text-muted">{msg || 'Loading...'}</p>
      ) : (
        <div className="mt-4 grid gap-4">
          {on ? (
            <p className="m-0 text-sm text-paper">Business is on{view.since ? ` since ${day(view.since)}` : ''}.</p>
          ) : null}

          <div className="rounded-[4px] border border-[#1f1f1f] bg-[#111111] p-4">
            <p className="m-0 font-sans text-xs uppercase tracking-[0.08em] text-muted">{on ? 'Your business terms' : 'Business terms'}</p>
            <ul className="m-0 mt-3 grid list-none gap-2.5 p-0">
              {view.terms.lines.map((line) => (
                <li key={line} className="flex gap-2.5 text-sm leading-relaxed text-paper">
                  <span aria-hidden className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-sun" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          {on ? (
            confirmOff ? (
              <div className="grid gap-3">
                <p className="m-0 text-sm text-paper">Turn Business off? Payments you receive after this are not charged the 1%.</p>
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
              <button type="button" className="btn btn-ghost justify-self-start" disabled={busy} onClick={() => setConfirmOff(true)}>
                Turn Business off
              </button>
            )
          ) : (
            <>
              <label className="flex cursor-pointer items-start gap-3 text-sm text-paper">
                <input
                  type="checkbox"
                  className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-sun"
                  checked={agreed}
                  disabled={busy}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                <span>I have read these terms and agree to them.</span>
              </label>
              <button type="button" className="btn btn-primary justify-self-start" disabled={busy || !agreed} onClick={() => void save(true)}>
                {busy ? 'Saving...' : 'Turn Business on'}
              </button>
            </>
          )}
          {msg ? <div className="alert alert-error text-sm">{msg}</div> : null}
        </div>
      )}
    </AppSection>
  );
}
