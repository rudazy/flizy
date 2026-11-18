import Link from 'next/link';
import type { ReactNode } from 'react';
import { GIWA_FAUCET_URL } from '../lib/botPublic';
import { ENTITY_LINE } from '../lib/entity';
import { PublicMailList } from './PublicMailList';
import { TelegramGlyph, WhatsAppGlyph, XLogoIcon } from './ExploreIcons';

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
    <footer className="mt-auto overflow-x-clip border-t border-border">
      <div className="mx-auto max-w-[1200px] px-4 py-10 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4 sm:gap-6">
          <div className="min-w-0">
            <Link href="/" className="flex items-center gap-3 no-underline">
              <span className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-surface font-sans text-lg font-semibold text-lime shadow-glow">
                F
              </span>
              <span className="font-sans text-sm font-semibold tracking-[0.18em] text-paper">FLIZY</span>
            </Link>
          </div>
          <nav aria-label="Flizy on chat and social" className="flex w-full gap-2.5 sm:w-auto sm:shrink-0">
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

function GlobeGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </svg>
  );
}
