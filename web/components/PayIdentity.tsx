'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { formatPayCode } from '../lib/dashboardTypes';
import { PREF_CARD, PrefHero } from './AccountPrefs';
import { buildPayLink, PAY_NOTE_MAX } from '../lib/payLink';
import { PAY_ASSETS, type PayAsset } from '../lib/payAsset';
import { symbolLabel } from '../lib/listedTokens';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('logo'));
    img.src = src;
  });
}

function drawCenterMark(canvas: HTMLCanvasElement, logo: HTMLImageElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = canvas.width;
  const mark = Math.round(size * 0.2);
  const pad = 7;
  const x = (size - mark) / 2;
  const y = (size - mark) / 2;
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(x - pad, y - pad, mark + pad * 2, mark + pad * 2);
  ctx.drawImage(logo, x, y, mark, mark);
}

export function PayIdentity({
  url,
  qrUrl,
  username,
  code,
}: {
  /** Shareable /pay/{username} link. Typed and pasted by people. */
  url: string;
  /**
   * What the QR encodes: /pay/c/{code}, and nothing else. Routes on the
   * permanent code, carries no name, so printed paper survives a rename.
   */
  qrUrl: string;
  /** Offered as a copy field; deliberately NOT printed. See the sheet below. */
  username: string | null;
  /**
   * Printed under the QR as the readable fallback. The QR and this code are the
   * same permanent identifier, so a scratched or badly lit QR drops the payer
   * onto the same routing key rather than onto the username, which can move and
   * can be taken by someone else.
   */
  code?: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [qrReady, setQrReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const QR = await import('qrcode');
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        await QR.toCanvas(canvas, qrUrl, {
          width: 280,
          margin: 2,
          errorCorrectionLevel: 'H',
          color: { dark: '#0a0a0a', light: '#f5f5f5' },
        });
        let logo: HTMLImageElement;
        try {
          logo = await loadImage('/favicon.svg');
        } catch {
          logo = await loadImage('/icon-192.png');
        }
        if (cancelled || !canvasRef.current) return;
        drawCenterMark(canvas, logo);
        setQrReady(true);
      } catch {
        if (!cancelled) setQrReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [qrUrl]);

  function onPrint() {
    window.print();
  }

  function onDownload() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `flizy-pay-${username || 'me'}.png`;
    a.click();
  }

  const link = url.replace(/^https?:\/\//, '');

  return (
    <section className={`pay-print ${PREF_CARD} print:border-0 print:bg-white print:shadow-none`}>
      <div className="print:hidden">
        <PrefHero
          eyebrow="Receive payment"
          title="Pay"
          accent="me"
          text="Let others pay you easily. Scan the QR code or share your username or Flizy number."
          art={<Swoosh />}
          corner={<BrandMark />}
        />
      </div>

      <div className="relative grid gap-4 px-4 pb-5 sm:px-5">
        <LowerGlow />

        <div className="relative mx-auto w-full max-w-[300px] print:max-w-[260px]">
          <div className="rounded-[20px] bg-[linear-gradient(145deg,rgba(247,208,71,0.85),rgba(140,104,22,0.55)_45%,rgba(247,208,71,0.8))] p-[2px] shadow-[0_0_36px_-6px_rgba(247,208,71,0.55)] print:bg-none print:p-0 print:shadow-none">
            <div className="rounded-[18px] bg-[#0b0b0b] p-3 print:bg-white print:p-0">
              <canvas
                ref={canvasRef}
                width={280}
                height={280}
                className="block aspect-square h-auto w-full rounded-[10px] bg-[#f5f5f5]"
                aria-label="Pay QR"
              />
            </div>
          </div>
          {!qrReady ? <p className="m-0 mt-2 text-center font-sans text-[12px] text-[#9a958c] print:hidden">Preparing QR...</p> : null}
        </div>

        {/*
          Printed sheet carries the Flizy number alone -- the bank-account model.
          You give out the number; the payer sees whose account it is on the
          confirm screen, read live. A name on paper is the only thing here that
          could go stale, so it is not on the paper. Spoken name is "Flizy
          number", not "pay code" (OTP) and not "account number" (NUBAN).
        */}
        <div className="relative flex items-center gap-3 rounded-[14px] border border-[#5a4a1f] bg-[linear-gradient(180deg,rgba(247,208,71,0.06),rgba(247,208,71,0.01))] px-5 py-4 print:justify-center print:border-0 print:bg-none print:p-0">
          <div className="min-w-0 flex-1 print:flex-none print:text-center">
            <p className="m-0 font-mono text-[10.5px] font-medium uppercase tracking-[0.24em] text-[#d9c58a] print:text-black">
              Flizy number
            </p>
            {code ? (
              <p className="m-0 mt-1.5 font-mono text-[26px] font-semibold tracking-[0.18em] text-white print:text-black sm:text-[30px]">
                {formatPayCode(code)}
              </p>
            ) : (
              <p className="m-0 mt-1.5 font-sans text-[13px] text-[#9a958c]">Your Flizy number is issued shortly.</p>
            )}
          </div>
          {/* Copy gives the bare digits; the grouping is for eyes only. */}
          {code ? <CopyTile value={code} label="Copy Flizy number" /> : null}
        </div>

        <div className="relative grid gap-3 sm:grid-cols-2 print:hidden">
          {username ? <Field label="Username" value={`@${username}`} copyLabel="Copy @username" /> : null}
          <Field label="Pay link" value={link} copyValue={url} copyLabel="Copy pay link" muted />
        </div>

        <div className="relative mt-3 print:hidden">
          <h3 className="m-0 font-sans text-[22px] font-bold leading-tight tracking-[0.01em] text-white">Request payment</h3>
          <p className="m-0 mt-1.5 font-sans text-[14px] text-[#b7b1a8]">Create a payment link or QR for any amount.</p>
        </div>

        <AskBuilder url={url} />

        <OutsidePayToggle />

        <a
          href="/dashboard/received"
          className="group relative flex min-h-[54px] items-center gap-3 rounded-[14px] border border-[#2a2a2e] bg-[#0d0d0e] px-4 font-sans text-[14.5px] font-medium text-[#f5f5f5] no-underline transition-colors hover:border-[#4a4a50] print:hidden"
        >
          <BarsGlyph />
          <span className="min-w-0 flex-1">Payments received, totals and CSV</span>
          <ChevronGlyph />
        </a>

        <div className="relative grid grid-cols-2 gap-3 print:hidden">
          <button
            type="button"
            onClick={onDownload}
            disabled={!qrReady}
            className="flex h-[52px] items-center justify-center gap-2.5 rounded-[12px] border border-[#6b5822] bg-[#0d0d0e] font-sans text-[15px] font-semibold text-white transition-colors hover:border-[#9a7f2c] disabled:opacity-50"
          >
            <DownloadGlyph />
            Download QR
          </button>
          <button
            type="button"
            onClick={onPrint}
            className="btn-sun flex h-[52px] items-center justify-center gap-2.5 rounded-[12px] font-sans text-[15px] font-semibold shadow-[0_0_28px_-6px_rgba(247,208,71,0.55)]"
          >
            <PrintGlyph />
            Print QR
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Ask for a set amount: the same pay link with the amount, asset and note
 * filled in, ready to paste into a chat. The payer still reviews it, and the
 * server checks every field again when they pay.
 */
function AskBuilder({ url }: { url: string }) {
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState<PayAsset>('TUSD');
  const [note, setNote] = useState('');
  const amountId = useId();
  const noteId = useId();
  const ask = Number(amount) > 0 ? buildPayLink(url, { amount, asset, note }) : null;

  return (
    <div className="relative grid gap-4 overflow-hidden rounded-[16px] border border-[#3a3220] bg-[linear-gradient(160deg,#151410_0%,#0d0d0d_55%)] px-4 pb-5 pt-5 shadow-[0_0_0_1px_rgba(247,208,71,0.03)] print:hidden">
      <CornerSweep />
      <div className="relative">
        <p className="m-0 font-sans text-[18px] font-bold text-white">Amount</p>
        <p className="m-0 mt-1 max-w-[86%] font-sans text-[13px] leading-snug text-[#b7b1a8]">Choose a currency and enter the amount you want to receive.</p>
      </div>
      <div className="relative flex gap-3" role="group" aria-label="Asset">
        {PAY_ASSETS.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => setAsset(opt)}
            aria-pressed={asset === opt}
            className={`h-[46px] flex-1 rounded-[10px] font-sans text-[15px] transition-colors ${
              asset === opt ? 'btn-sun' : 'border border-[#3a3a3e] bg-[#0b0b0b] text-[#e8e4dc] hover:border-[#5a5a60] hover:text-white'
            }`}
          >
            {symbolLabel(opt)}
          </button>
        ))}
      </div>
      <label htmlFor={amountId} className="relative grid gap-2">
        <span className="font-sans text-[13px] text-[#9a958c]">Amount</span>
        <input
          id={amountId}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.trim())}
          placeholder={asset === 'TUSD' ? '50' : asset === 'FLZ' ? '10' : '0.01'}
          className="input h-[52px] !rounded-[10px] !border-[#2e2e32] !bg-[#0b0b0b] !px-5 font-sans !text-[17px] font-medium"
        />
      </label>
      <label htmlFor={noteId} className="relative grid gap-2">
        <span className="font-sans text-[13px] text-[#9a958c]">Note (optional)</span>
        <input
          id={noteId}
          value={note}
          maxLength={PAY_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Design work"
          className="input h-[52px] !rounded-[10px] !border-[#2e2e32] !bg-[#0b0b0b] !px-5 font-sans !text-[17px]"
        />
      </label>
      {ask ? (
        <div className="relative">
          <Field label="Link for this ask" value={ask.replace(/^https?:\/\//, '')} copyValue={ask} copyLabel="Copy link for this ask" muted />
        </div>
      ) : null}
    </div>
  );
}

/** One gold line curving down the amount card's top right corner. */
function CornerSweep() {
  const id = useId().replace(/:/g, '');
  return (
    <svg aria-hidden viewBox="0 0 200 120" preserveAspectRatio="none" className="pointer-events-none absolute right-0 top-0 h-[64px] w-[120px]">
      <defs>
        <linearGradient id={`${id}-c`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#f7d047" stopOpacity="0" />
          <stop offset="0.7" stopColor="#f7d047" stopOpacity="0.9" />
          <stop offset="1" stopColor="#f7d047" stopOpacity="0.6" />
        </linearGradient>
        <radialGradient id={`${id}-r`} cx="1" cy="0" r="1">
          <stop offset="0" stopColor="#f7d047" stopOpacity="0.16" />
          <stop offset="1" stopColor="#f7d047" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-b`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
      </defs>
      <rect width="200" height="120" fill={`url(#${id}-r)`} />
      <g fill="none" stroke={`url(#${id}-c)`} strokeLinecap="round">
        <path d="M40 120 C 110 105, 140 20, 200 4" strokeWidth="5" opacity="0.4" filter={`url(#${id}-b)`} />
        <path d="M40 120 C 110 105, 140 20, 200 4" strokeWidth="1.3" />
      </g>
    </svg>
  );
}

/**
 * Let wallets outside Flizy pay this link. Off by default, because it hands the
 * wallet address to anyone with the link, which ties the @username and Flizy
 * number to that wallet's activity on the chain (/api/account/outside-pay).
 */
function OutsidePayToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const titleId = useId();
  const textId = useId();

  useEffect(() => {
    let live = true;
    fetch('/api/account/outside-pay', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => live && setEnabled(body?.enabled === true))
      .catch(() => live && setEnabled(false));
    return () => {
      live = false;
    };
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/account/outside-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof body.error === 'string' ? body.error : 'Could not save that.');
        return;
      }
      setEnabled(body.enabled === true);
    } catch {
      setError('Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative grid gap-2 rounded-[14px] border border-[#2e2a1e] bg-[#0d0d0e] px-4 py-4 print:hidden">
      <div className="flex items-start gap-3">
        <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[9px] bg-[#2a2414] text-sun" aria-hidden>
          <LayersGlyph />
        </span>
        <div className="min-w-0 flex-1">
          <p id={titleId} className="m-0 font-sans text-[14.5px] font-semibold leading-snug text-white">
            Accept payments from other wallets
          </p>
          <p id={textId} className="m-0 mt-1 font-sans text-[12.5px] leading-relaxed text-[#b7b1a8]">
            Let people without a Flizy account pay with their own wallet. Anyone with your link can also view your
            wallet address and onchain activity.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled === true}
          aria-labelledby={titleId}
          aria-describedby={textId}
          disabled={enabled === null || busy}
          onClick={() => void toggle(enabled !== true)}
          className={`hit-44 relative mt-0.5 h-[28px] w-[50px] shrink-0 rounded-full transition-colors disabled:opacity-60 ${
            enabled === true ? 'bg-[linear-gradient(180deg,#f9d95d,#f7d043)] shadow-[0_0_14px_-2px_rgba(247,208,71,0.6)]' : 'bg-[#3a3a40]'
          }`}
        >
          <span
            className={`absolute top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow transition-[left] ${
              enabled === true ? 'left-[25px]' : 'left-[3px]'
            }`}
          />
        </button>
      </div>
      {error ? (
        <p className="m-0 font-sans text-[12.5px] text-[#e0b070]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  copyValue,
  copyLabel,
  muted = false,
}: {
  label: string;
  value: string;
  copyValue?: string;
  copyLabel: string;
  muted?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-[14px] border border-[#2a2a2e] bg-[#0f0f10] px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="m-0 font-mono text-[10px] font-medium uppercase tracking-[0.24em] text-[#9a958c]">{label}</p>
        <p className={`m-0 mt-1 truncate font-sans text-[16px] font-medium ${muted ? 'text-[#d9d4ca]' : 'text-white'}`} title={value}>
          {value}
        </p>
      </div>
      <CopyTile value={copyValue ?? value} label={copyLabel} />
    </div>
  );
}

function CopyTile({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch {
      setDone(false);
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
      className={`hit-44 flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] border transition-colors print:hidden ${
        done ? 'border-sun/70 text-sun' : 'border-[#3a3a3e] bg-[#151517] text-[#d9d4ca] hover:text-white'
      }`}
    >
      {done ? <TickGlyph /> : <CopyGlyph />}
    </button>
  );
}

/** FLIZY wordmark and line, top right of the hero. */
function BrandMark() {
  return (
    <div className="pointer-events-none absolute right-5 top-6 text-right max-[380px]:hidden" aria-hidden>
      <p className="m-0 font-mono text-[15px] font-semibold tracking-[0.42em] text-[#e9d27a]">FLIZY</p>
      <p className="m-0 mt-1 font-mono text-[8.5px] tracking-[0.2em] text-[#a69a74]">SIMPLE. SOCIAL. GLOBAL.</p>
    </div>
  );
}

/** Gold light ribbons sweeping in from the top right. Drawn, so it is sharp at any size. */
function Swoosh() {
  const id = useId().replace(/:/g, '');
  return (
    // The outer fade ends the light before the hero's lower edge, so it never stops on a hard line.
    <div aria-hidden className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(180deg,#000_55%,transparent_96%)]">
      <svg
        viewBox="0 0 420 200"
        preserveAspectRatio="xMaxYMin slice"
        className="h-full w-full [mask-image:linear-gradient(90deg,transparent_20%,#000_65%)]"
      >
        <defs>
          <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f7d047" stopOpacity="0" />
            <stop offset="0.45" stopColor="#f7d047" stopOpacity="0.9" />
            <stop offset="1" stopColor="#f7d047" stopOpacity="0.15" />
          </linearGradient>
          <filter id={`${id}-b`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>
        <g fill="none" stroke={`url(#${id}-g)`} strokeLinecap="round">
          <path d="M200 0 C 280 30, 330 70, 420 170" strokeWidth="6" opacity="0.35" filter={`url(#${id}-b)`} />
          <path d="M200 0 C 280 30, 330 70, 420 170" strokeWidth="1.4" />
          {[8, 16, 24, 32, 40, 48].map((d, i) => (
            <path key={d} d={`M${205 + d} 0 C ${285 + d} ${28 + d / 2}, ${335 + d / 2} ${66 + d}, 420 ${160 - d}`} strokeWidth={0.6} opacity={0.55 - i * 0.07} />
          ))}
        </g>
      </svg>
    </div>
  );
}

/** A faint ribbon low on the left, behind the QR. Phone only: on a wide card it reads as a stray line. */
function LowerGlow() {
  const id = useId().replace(/:/g, '');
  return (
    <svg aria-hidden viewBox="0 0 400 260" preserveAspectRatio="none" className="pointer-events-none absolute left-0 top-[110px] h-[260px] w-full opacity-60 print:hidden sm:hidden">
      <defs>
        <linearGradient id={`${id}-l`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f7d047" stopOpacity="0.5" />
          <stop offset="0.6" stopColor="#f7d047" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#${id}-l)`} strokeLinecap="round">
        {[0, 10, 20, 30].map((d) => (
          <path key={d} d={`M0 ${120 + d} C 60 ${100 + d}, 110 ${150 + d}, 180 ${190 + d / 2}`} strokeWidth="0.8" />
        ))}
      </g>
    </svg>
  );
}

function CopyGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5h10" />
    </svg>
  );
}

function TickGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LayersGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M12 4l8 4.5-8 4.5-8-4.5L12 4z" strokeLinejoin="round" />
      <path d="M4 12.5l8 4.5 8-4.5M4 16.5l8 4.5 8-4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BarsGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="shrink-0 text-[#d9d4ca]" aria-hidden>
      <path d="M3.5 20.5h17M6 20.5V12m4 8.5V6m4 14.5V9.5m4 11V4" strokeLinecap="round" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-[#d9d4ca] transition-transform group-hover:translate-x-0.5" aria-hidden>
      <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DownloadGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M4.5 19.5h15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PrintGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M7 8V3.5h10V8M7 17H4.5V9.5a1.5 1.5 0 0 1 1.5-1.5h12a1.5 1.5 0 0 1 1.5 1.5V17H17" strokeLinejoin="round" />
      <rect x="7" y="14" width="10" height="6.5" rx="1" />
    </svg>
  );
}
