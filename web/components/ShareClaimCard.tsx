'use client';

import { useState } from 'react';
import { telegramShareHref } from '../lib/claimShare.ts';
import type { ClaimShare } from '../lib/claimShareView.ts';

type Channel = 'share_link' | 'whatsapp' | 'telegram';

/**
 * Share a claim you sent: copy the link, send it on WhatsApp or Telegram, or
 * the device's share sheet where there is one. The message is the same one
 * chat sends. Each use is noted on the claim's timeline (/api/claim/shared).
 */
export function ShareClaimCard({ claimId, share }: { claimId: string; share: ClaimShare }) {
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
