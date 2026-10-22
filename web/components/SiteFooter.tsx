import Link from 'next/link';
import type { ReactNode } from 'react';
import { GIWA_FAUCET_URL } from '../lib/botPublic';
import { ENTITY_LINE } from '../lib/entity';
import { PublicMailList } from './PublicMailList';
import { XLogoIcon } from './ExploreIcons';

const TEXT_LINK = 'text-muted no-underline hover:text-lime';

/**
 * The public footer: mark and line, the chat bots and X as icons, then the
 * company line, contact and the text links.
 *
 * The bot links come from the server (web/app/layout.tsx). Telegram opens the
 * bot when TELEGRAM_BOT_USERNAME is set; WhatsApp opens the bot only where the
 * deploy allows its number in public HTML (web/lib/botPublic.ts). Otherwise
 * both go to the Guide, which shows how to link a chat.
 */
export function SiteFooter({ telegramUrl = null, whatsappUrl = null }: { telegramUrl?: string | null; whatsappUrl?: string | null }) {
  return (
    <footer className="mt-auto border-t border-border">
      <div className="mx-auto max-w-[1200px] px-6 py-10">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <Link href="/" className="flex items-center gap-3 no-underline">
              <span className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-surface font-sans text-lg font-semibold text-lime shadow-glow">
                F
              </span>
              <span className="font-sans text-sm font-semibold tracking-[0.18em] text-paper">FLIZY</span>
            </Link>
          </div>
          <nav aria-label="Flizy on chat and social" className="flex shrink-0 gap-2.5">
            <FooterIcon href={telegramUrl ?? '/how-it-works'} label="Flizy on Telegram" external={Boolean(telegramUrl)}>
              <TelegramGlyph />
            </FooterIcon>
            <FooterIcon href={whatsappUrl ?? '/how-it-works'} label="Flizy on WhatsApp" external={Boolean(whatsappUrl)}>
              <WhatsAppGlyph />
            </FooterIcon>
            <FooterIcon href="https://x.com/Flizyapp" label="Flizy on X" external>
              <XLogoIcon size={17} />
            </FooterIcon>
            <FooterIcon href="/" label="Flizy home">
              <GlobeGlyph />
            </FooterIcon>
          </nav>
        </div>
        <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">
          Chat wallet for WhatsApp and Telegram.
          <br />
          Trusted sends. Built for GIWA and EVM.
        </p>

        <div className="mt-6 border-t border-border pt-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
            {/*
              Plain text, not a link. A link is something nobody clicks; the line
              itself is what signals there is a real company behind the site, and
              it has to be readable without any further action.
            */}
            <p className="m-0">{ENTITY_LINE}</p>
            <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
            <PublicMailList ids={['contact']} className="m-0 text-sm" />
          </div>
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
            <Link href="/how-it-works" className={TEXT_LINK}>
              Guide
            </Link>
            <a href={GIWA_FAUCET_URL} className={TEXT_LINK} target="_blank" rel="noreferrer">
              GIWA faucet
            </a>
            <Link href="/docs" className={TEXT_LINK}>
              Docs
            </Link>
            <Link href="/terms" className={TEXT_LINK}>
              Terms
            </Link>
            <Link href="/privacy" className={TEXT_LINK}>
              Privacy
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterIcon({ href, label, external = false, children }: { href: string; label: string; external?: boolean; children: ReactNode }) {
  const className =
    'flex h-11 w-11 items-center justify-center rounded-[8px] border border-border bg-surface text-paper no-underline transition-colors hover:border-lime/50 hover:text-lime';
  return external ? (
    <a href={href} aria-label={label} title={label} className={className} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <Link href={href} aria-label={label} title={label} className={className}>
      {children}
    </Link>
  );
}

function TelegramGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M21.5 3.5L2.8 10.8c-.8.3-.8 1.4 0 1.7l4.6 1.6 1.8 5.6c.2.7 1.1.9 1.6.4l2.6-2.4 4.7 3.5c.6.4 1.4.1 1.6-.6L22.9 4.9c.2-.9-.6-1.7-1.4-1.4z" />
      <path d="M7.4 14.1l11.1-7.4-8.4 9" strokeLinecap="round" />
    </svg>
  );
}

function WhatsAppGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 20.5l1.3-4.6A8.6 8.6 0 1112 20.6a8.5 8.5 0 01-4-1z" />
      <path
        d="M9 8.3c.2-.4.5-.4.8-.4h.4c.2 0 .3.1.4.3l.7 1.6c.1.2 0 .4-.1.5l-.5.6c-.1.1-.1.3 0 .5.6 1.1 1.5 1.9 2.6 2.4.2.1.4 0 .5-.1l.6-.7c.1-.2.3-.2.5-.1l1.6.7c.2.1.3.3.3.5v.4c0 .3-.1.6-.4.8-.6.5-1.4.6-2.2.4-2.4-.7-4.4-2.6-5.2-5-.2-.8 0-1.7.4-2.4z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

function GlobeGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </svg>
  );
}
