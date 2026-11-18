'use client';

import { useState } from 'react';
import { telegramShareHref } from '../lib/claimShare.ts';
import { CopyIcon, MoreHorizontalIcon, TelegramGlyph, WhatsAppGlyph } from './ExploreIcons';
import type { ClaimShare } from '../lib/claimShareView.ts';

type Channel = 'share_link' | 'whatsapp' | 'telegram';

/**
 * Share a claim you sent: copy the link, send it on WhatsApp or Telegram, or
 * the device's share sheet where there is one. The message is the same one
 * chat sends. Each use is noted on the claim's timeline (/api/claim/shared).
 *
 * `page` is the claim page's form: the message in a box with a copy button,
 * then WhatsApp, Telegram and More as equal buttons. History keeps the
 * compact form.
 */
export function ShareClaimCard({ claimId, share, page = false }: { claimId: string; share: ClaimShare; page?: boolean }) {
  const [copied, setCopied] = useState(false);
  const canShareSheet = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  function noted(channel: Channel) {
    void fetch('/api/claim/shared', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimId, channel }),
    }).catch(() => {});
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(share.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      noted('share_link');
    } catch {
      setCopied(false);
    }
  }

  async function sheet() {
    try {
      await navigator.share({ text: share.text });
      noted('share_link');
    } catch {
      // Closed without sharing.
    }
  }

  const wa = `https://wa.me/?text=${encodeURIComponent(share.text)}`;
  // Telegram puts the link above the text, so the text goes without it.
  const tg = telegramShareHref(share.url, share.text.split(share.url).join('').trim());

  if (page) {
    const button = 'flex min-h-[48px] min-w-0 items-center justify-center gap-1 rounded-[10px] border border-sun/25 bg-[#0d0c0a] px-1.5 font-sans text-[13px] text-paper no-underline transition-colors hover:border-sun/50 sm:gap-2 sm:px-2 sm:text-[15px]';
    return (
      <div className="grid min-w-0 gap-4">
        <div>
          <h2 className="m-0 font-sans text-[22px] font-semibold tracking-wide text-paper">Share claim link</h2>
          <p className="m-0 mt-1 text-[14px] text-[#bdb6ab]">Send the link to the person who should receive this payment.</p>
        </div>
        <div className="flex min-w-0 items-start gap-3 rounded-[10px] border border-chrome-line bg-[#141414] p-3">
          <p className="m-0 min-w-0 flex-1 text-[14px] leading-relaxed text-[#d8d2c8] [overflow-wrap:anywhere]">
            {share.text.split(share.url)[0]}
            <span className="underline underline-offset-2">{share.url}</span>
            {share.text.split(share.url).slice(1).join(share.url)}
          </p>
          <button
            type="button"
            aria-label={copied ? 'Copied' : 'Copy the message'}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] border border-chrome-line bg-[#0d0c0a] text-paper hover:border-sun/50"
            onClick={() => void copy()}
          >
            {copied ? <span className="text-[11px] text-sun">Copied</span> : <CopyIcon size={18} />}
          </button>
        </div>
        <div className={`grid gap-3 ${canShareSheet ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <a href={wa} target="_blank" rel="noreferrer noopener" className={button} onClick={() => noted('whatsapp')}>
            <span className="text-sun"><WhatsAppGlyph /></span>
            WhatsApp
          </a>
          <a href={tg} target="_blank" rel="noreferrer noopener" className={button} onClick={() => noted('telegram')}>
            <span className="text-sun"><TelegramGlyph /></span>
            Telegram
          </a>
          {canShareSheet ? (
            <button type="button" className={button} onClick={() => void sheet()}>
              <MoreHorizontalIcon size={18} className="text-sun" />
              More
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-[8px] rounded-[10px] border border-[#23242a] bg-[#111111] p-[12px]">
      <p className="m-0 font-sans text-[12.5px] font-semibold text-white">Share claim link</p>
      <p className="m-0 break-words font-mono text-[11.5px] leading-relaxed text-[#bdbdbd]">{share.text}</p>
      <div className="flex flex-wrap gap-[8px]">
        <button type="button" className="btn btn-ghost text-sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <a href={wa} target="_blank" rel="noreferrer noopener" className="btn btn-ghost text-sm no-underline" onClick={() => noted('whatsapp')}>
          WhatsApp
        </a>
        <a href={tg} target="_blank" rel="noreferrer noopener" className="btn btn-ghost text-sm no-underline" onClick={() => noted('telegram')}>
          Telegram
        </a>
        {canShareSheet ? (
          <button type="button" className="btn btn-ghost text-sm" onClick={() => void sheet()}>
            More
          </button>
        ) : null}
      </div>
    </div>
  );
}
