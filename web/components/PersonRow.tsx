'use client';

import Link from 'next/link';
import { profilePath } from '../lib/follows.ts';

/** One person in a follow list or a search result. The row opens their profile. */
export function PersonRow({
  username,
  displayName,
  layout = 'row',
}: {
  username: string;
  displayName: string | null;
  layout?: 'row' | 'card';
}) {
  const letter = username.slice(0, 1).toUpperCase();
  const card = layout === 'card';
  return (
    <Link
      href={profilePath(username)}
      className={
        card
          ? 'group flex min-h-[72px] items-center gap-3 rounded-[14px] border border-[#2a2b30] bg-[#101012] px-3.5 py-3 no-underline transition-colors hover:border-[#5a5138] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7d047]'
          : 'group flex min-h-[64px] items-center gap-3 border-t border-[#26262a] px-3.5 py-2.5 no-underline transition-colors hover:bg-[#16140f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7d047]'
      }
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#f7d047]/50 bg-[#14120e] font-sans text-[16px] font-semibold text-[#f7d047]">
        {letter}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[14px] font-semibold text-white">@{username}</span>
        {displayName ? <span className="mt-0.5 block truncate font-sans text-[12px] text-[#c8c2b8]">{displayName}</span> : null}
      </span>
      <Chevron />
    </Link>
  );
}

function Chevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-[#6f6a62] transition-colors group-hover:text-[#f7d047]">
      <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
