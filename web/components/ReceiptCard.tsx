'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  CloseIcon,
  CopyIcon,
  ExternalLinkIcon,
  GiwaMarkIcon,
  InfoIcon,
  ShieldCheckIcon,
  XLogoIcon,
} from './ExploreIcons';

/**
 * The shared receipt at /r/{token}: a ticket with the payment on it, then ways
 * to pass it on. Everything here is already on the page for whoever holds the
 * link; the buttons only copy or hand off that same link and its image.
 */

export type ReceiptCardProps = {
  amount: string;
  unit: string;
  usd: string | null;
  from: string;
  fromNote: string;
  to: string;
  toNote: string;
  toIsFlizy: boolean;
  note: string | null;
  when: string;
  network: string;
  txHash: string | null;
  hashLabel: string | null;
  explorerUrl: string | null;
  /** Site paths, made absolute in the browser. */
  pagePath: string;
  imagePath: string;
};

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function absolute(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export function ReceiptCard(p: ReceiptCardProps) {
  const [status, setStatus] = useState({ text: '', ok: true });

  function flash(text: string, ok = true) {
    setStatus({ text, ok });
    window.setTimeout(() => setStatus({ text: '', ok: true }), 1800);
  }

  const shareText = `Flizy receipt: ${p.amount} ${p.unit}`;

  function copyLink() {
    copy(absolute(p.pagePath));
    flash('Link copied');
  }

  async function shareLink() {
    const url = absolute(p.pagePath);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Flizy receipt', text: shareText, url });
        return;
      } catch {
        // A closed share sheet is not a failure; nothing else to do.
        return;
      }
    }
    copyLink();
  }

  /** The receipt image as a file, or null when it could not be drawn. */
  async function imageFile(): Promise<File | null> {
    try {
      const res = await fetch(p.imagePath);
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
      return new File([await res.blob()], 'flizy-receipt.png', { type: 'image/png' });
    } catch {
      return null;
    }
  }

  function save(file: File) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    flash('Image saved');
  }

  async function shareImage() {
    const file = await imageFile();
    if (!file) return flash('Could not make the image', false);
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Flizy receipt', text: shareText });
      } catch {
        // Closing the share sheet is not a failure.
      }
      return;
    }
    // No file sharing here (most desktops): save it instead.
    save(file);
  }

  async function download() {
    const file = await imageFile();
    if (file) save(file);
    else flash('Could not make the image', false);
  }

  const encodedUrl = () => encodeURIComponent(absolute(p.pagePath));
  const encodedText = encodeURIComponent(shareText);

  return (
    <div className="fade-up mx-auto w-full max-w-[480px]">
      <div className="rounded-[22px] border border-[#2a2620] bg-[#0d0c0b] px-4 pb-6 pt-5 shadow-[0_30px_80px_rgba(0,0,0,0.55)] sm:px-6">
        <header className="mb-4 flex items-start justify-between gap-4 sm:px-2">
          <div>
            <h1 className="m-0 font-sans text-[24px] font-bold text-white">Share Receipt</h1>
            <p className="m-0 mt-1 font-sans text-[15px] text-[#a8a29a]">A clean receipt to share with anyone.</p>
          </div>
          <Link
            href="/"
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-[#2c2a27] bg-[#121110] text-white no-underline hover:opacity-80"
          >
            <CloseIcon size={18} />
          </Link>
        </header>

        <section className="relative overflow-hidden rounded-t-[14px] border border-b-0 border-[#4a3c1a] bg-[radial-gradient(120%_60%_at_50%_0%,#1d1708_0%,#110f0b_55%,#0f0e0c_100%)] px-3 pb-6 pt-4 sm:px-4">
          <GoldSweep className="pointer-events-none absolute right-0 top-10 h-[150px] w-[120px]" />

          <div className="relative flex items-start justify-between gap-3">
            <Link href="/" className="flex items-center gap-3 no-underline" aria-label="Flizy home">
              <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[8px] border border-[#3a3017] bg-[#0a0908] font-sans text-[26px] font-bold text-sun">
                F
              </span>
              <span className="font-sans text-[17px] font-semibold tracking-[0.3em] text-white">FLIZY</span>
            </Link>
            <div className="flex items-center gap-2 text-right">
              <div className="font-sans text-[12px] leading-tight">
                <p className="m-0 text-sun">Payment Receipt</p>
                <p className="m-0 mt-0.5 text-[#a8a29a]">Verified on blockchain</p>
              </div>
              <ShieldCheckIcon size={26} className="shrink-0 text-sun" />
            </div>
          </div>

          <div className="relative mt-3 grid justify-items-center text-center">
            <CheckSeal />
            <h2 className="m-0 mt-3 font-sans text-[26px] font-bold text-white">Payment Successful</h2>
            <p className="m-0 mt-1.5 font-sans text-[16px] text-[#b7b1a8]">Amount sent</p>
            <p className="m-0 mt-1 flex flex-wrap items-baseline justify-center gap-x-3 font-sans font-bold leading-none">
              <span className="text-[52px] tracking-tight text-white">{p.amount}</span>
              <span className="text-[44px] text-sun">{p.unit}</span>
            </p>
            <span className="mt-4 inline-flex max-w-full items-center gap-3 rounded-full border border-[#2c2a27] bg-[#0c0b0a] px-4 py-2 font-sans text-[15px]">
              <span className="truncate text-white">{p.to}</span>
              {p.toIsFlizy ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-[#3ddc84]">
                  <CheckBadge />
                  Flizy user
                </span>
              ) : null}
            </span>
          </div>

          <dl className="relative m-0 mt-4 border-t border-[#24211d] px-1">
            <Row name="From" copyText={p.from}>
              <span className="block truncate">{p.from}</span>
              <span className="block text-[14px] text-[#9a958c]">{p.fromNote}</span>
            </Row>
            <Row name="To" copyText={p.to}>
              <span className="block truncate">{p.to}</span>
              <span className="block text-[14px] text-[#9a958c]">{p.toNote}</span>
            </Row>
            <Row name="Amount" copyText={`${p.amount} ${p.unit}`}>
              <span className="block">
                {p.amount} {p.unit}
              </span>
              {p.usd ? <span className="block text-[14px] text-[#9a958c]">{p.usd}</span> : null}
            </Row>
            {p.note ? (
              <Row name="For">
                <span className="block break-words">{p.note}</span>
              </Row>
            ) : null}
            <Row name="Network" copyText={p.network}>
              <span className="flex min-w-0 items-center justify-end gap-2.5">
                <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-[#5a4718] bg-[#14110a] text-sun">
                  <GiwaMarkIcon size={13} />
                </span>
                <span className="min-w-0 truncate">{p.network}</span>
              </span>
            </Row>
            <Row name="Date & time">
              {p.when}
            </Row>
            {p.txHash && p.hashLabel ? (
              <Row name="Transaction hash" copyText={p.txHash} href={p.explorerUrl} last>
                <span className="block truncate">{p.hashLabel}</span>
              </Row>
            ) : null}
          </dl>

          <div className="relative mt-3 overflow-hidden rounded-[12px] border border-[#2a2620] bg-[#0f0e0c] px-4 py-3.5">
            <GoldSweep className="pointer-events-none absolute -right-2 bottom-0 h-[70px] w-[130px] opacity-70" />
            <div className="relative flex items-start gap-3">
              <InfoIcon size={20} className="mt-0.5 shrink-0 text-sun" />
              <p className="m-0 font-sans text-[13px] leading-relaxed text-[#b7b1a8]">
                This receipt was shared by someone in this payment.
                <br />
                {p.network} is a test network; these funds have no cash value.
              </p>
            </div>
          </div>
        </section>
        <TicketEdge />

        <div className="mt-6 grid grid-cols-3 gap-2.5 sm:gap-3">
          <button
            type="button"
            onClick={() => void shareImage()}
            className="flex min-h-[52px] items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] bg-sun px-1.5 font-sans text-[14px] sm:gap-2 sm:text-[15px] font-semibold text-sun-ink hover:opacity-90"
          >
            <ShareGlyph />
            Share image
          </button>
          <button
            type="button"
            onClick={copyLink}
            className="flex min-h-[52px] items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] border border-[#2c2a27] bg-[#0c0b0a] px-1.5 font-sans text-[14px] sm:gap-2 sm:text-[15px] text-white hover:opacity-80"
          >
            <CopyIcon size={18} />
            Copy link
          </button>
          <button
            type="button"
            onClick={() => void download()}
            className="flex min-h-[52px] items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] border border-[#2c2a27] bg-[#0c0b0a] px-1.5 font-sans text-[14px] sm:gap-2 sm:text-[15px] text-white hover:opacity-80"
          >
            <DownloadGlyph />
            Download
          </button>
        </div>

        <div className="mt-5 grid grid-cols-5 gap-1">
          <ShareTarget
            label="WhatsApp"
            onClick={() => window.open(`https://wa.me/?text=${encodedText}%20${encodedUrl()}`, '_blank', 'noopener,noreferrer')}
          >
            <WhatsAppGlyph />
          </ShareTarget>
          <ShareTarget
            label="Telegram"
            onClick={() =>
              window.open(`https://t.me/share/url?url=${encodedUrl()}&text=${encodedText}`, '_blank', 'noopener,noreferrer')
            }
          >
            <TelegramGlyph />
          </ShareTarget>
          <ShareTarget
            label="X (Twitter)"
            onClick={() =>
              window.open(`https://x.com/intent/post?text=${encodedText}&url=${encodedUrl()}`, '_blank', 'noopener,noreferrer')
            }
          >
            <XLogoIcon size={24} />
          </ShareTarget>
          <ShareTarget label="Copy link" onClick={copyLink}>
            <LinkGlyph />
          </ShareTarget>
          <ShareTarget label="More" onClick={() => void shareLink()}>
            <DotsGlyph />
          </ShareTarget>
        </div>

        <p className={`m-0 mt-3 h-5 text-center font-sans text-[13px] ${status.ok ? 'text-[#3ddc84]' : 'text-[#e0b070]'}`} role="status" aria-live="polite">
          {status.text}
        </p>
      </div>
    </div>
  );
}

/** One line of the ticket: name, value, then copy or open. */
function Row({
  name,
  children,
  copyText,
  href,
  last = false,
}: {
  name: string;
  children: ReactNode;
  copyText?: string;
  href?: string | null;
  last?: boolean;
}) {
  return (
    <div className={`flex min-h-[64px] items-center gap-3 py-3 ${last ? '' : 'border-b border-[#24211d]'}`}>
      <dt className="w-[108px] shrink-0 font-sans text-[14px] leading-snug text-[#a8a29a] sm:text-[15px]">{name}</dt>
      <dd className="m-0 min-w-0 flex-1 text-right font-sans text-[14.5px] leading-snug text-white sm:text-[15.5px]">{children}</dd>
      <span className="flex shrink-0 items-center gap-2.5">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open on explorer"
            className="inline-flex text-[#d9d4ca] hover:text-white"
          >
            <ExternalLinkIcon size={20} />
          </a>
        ) : null}
        {copyText ? <CopyButton text={copyText} label={`Copy ${name.toLowerCase()}`} /> : <span className="w-5" aria-hidden />}
      </span>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      className={`inline-flex ${copied ? 'text-[#3ddc84]' : 'text-[#d9d4ca] hover:text-white'}`}
      onClick={() => {
        copy(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      <CopyIcon size={20} />
    </button>
  );
}

function ShareTarget({
  label,
  circle = 'border-[#3a3833] bg-[#0c0b0a] text-white',
  onClick,
  children,
}: {
  label: string;
  circle?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className="grid min-w-0 justify-items-center gap-2 font-sans text-[12px] leading-tight text-[#d9d4ca] hover:opacity-80">
      <span className={`flex h-11 w-11 items-center justify-center rounded-full border [&>svg]:h-[18px] [&>svg]:w-[18px] ${circle}`}>{children}</span>
      <span className="max-w-full text-center">{label}</span>
    </button>
  );
}

/** The gold check in a lit ring. */
function CheckSeal() {
  return (
    <span className="relative flex h-[118px] w-[118px] items-center justify-center" aria-hidden>
      <span className="absolute inset-0 rounded-full bg-[radial-gradient(circle,#2a2008_0%,#17130a_58%,transparent_72%)]" />
      <span className="relative flex h-[86px] w-[86px] items-center justify-center rounded-full border-[3px] border-sun shadow-[0_0_34px_rgba(247,208,71,0.25)]">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#f7d047" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </span>
    </span>
  );
}

/** Fine gold contour lines, the ticket's only ornament. */
function GoldSweep({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 150" fill="none" preserveAspectRatio="none" className={className} aria-hidden>
      {Array.from({ length: 9 }, (_, i) => (
        <path
          key={i}
          d={`M${8 + i * 6} 0 C ${50 + i * 4} ${40 + i * 3}, ${80 + i * 2} ${70 + i * 4}, 120 ${118 + i * 3}`}
          stroke="#f7d047"
          strokeOpacity={0.08 + i * 0.03}
          strokeWidth="0.8"
        />
      ))}
    </svg>
  );
}

/** The torn-ticket bottom: a row of notches cut in the frame colour. */
function TicketEdge() {
  return (
    <div className="border-x border-[#4a3c1a] bg-[#0f0e0c] pb-1" aria-hidden>
      <svg width="100%" height="7" className="block translate-y-[6px]">
        <defs>
          <pattern id="receipt-scallop" width="12" height="7" patternUnits="userSpaceOnUse">
            <path d="M0 0.5A6 6 0 0 0 12 0.5Z" fill="#0f0e0c" />
            <path d="M0 0.5A6 6 0 0 0 12 0.5" fill="none" stroke="#4a3c1a" />
          </pattern>
        </defs>
        <rect width="100%" height="7" fill="url(#receipt-scallop)" />
      </svg>
    </div>
  );
}

function CheckBadge() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function ShareGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <path d="M12 15V3M7.5 7.5L12 3l4.5 4.5" />
      <path d="M8 10.5H6a1.5 1.5 0 00-1.5 1.5v7.5A1.5 1.5 0 006 21h12a1.5 1.5 0 001.5-1.5V12a1.5 1.5 0 00-1.5-1.5h-2" />
    </svg>
  );
}

function DownloadGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <path d="M12 3v12M7.5 10.5L12 15l4.5-4.5M4 17v2.5A1.5 1.5 0 005.5 21h13a1.5 1.5 0 001.5-1.5V17" />
    </svg>
  );
}

function LinkGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M10 14a4.5 4.5 0 006.4 0l3-3a4.5 4.5 0 00-6.4-6.4l-1.2 1.2" />
      <path d="M14 10a4.5 4.5 0 00-6.4 0l-3 3a4.5 4.5 0 006.4 6.4l1.2-1.2" />
    </svg>
  );
}

function DotsGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5.5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="18.5" cy="12" r="1.8" />
    </svg>
  );
}

function TelegramGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.7 4.1L3.4 10.8c-1.2.5-1.2 1.2-.2 1.5l4.4 1.4 1.7 5.2c.2.6.4.8.8.8.4 0 .6-.2.9-.4l2.1-2.1 4.4 3.3c.8.4 1.4.2 1.6-.8l2.9-13.7c.3-1.2-.4-1.7-1.3-1.3zM9.1 14.3l8.6-5.4c.4-.3.8-.1.5.2l-7.4 6.7-.3 3.1-1.4-4.6z" />
    </svg>
  );
}

function WhatsAppGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 20.5l1.3-4.6A8.6 8.6 0 1112 20.6a8.5 8.5 0 01-4-1z" />
      <path
        d="M9 8.3c.2-.4.5-.4.8-.4h.4c.2 0 .3.1.4.3l.7 1.6c.1.2 0 .4-.1.5l-.5.6c-.1.1-.1.3 0 .5.6 1.1 1.5 1.9 2.6 2.4.2.1.4 0 .5-.1l.6-.7c.1-.2.3-.2.5-.1l1.6.7c.2.1.3.3.3.5v.4c0 .3-.1.6-.4.8-.6.5-1.4.6-2.2.4-2.4-.7-4.4-2.6-5.2-5-.2-.8 0-1.7.4-2.4z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}
