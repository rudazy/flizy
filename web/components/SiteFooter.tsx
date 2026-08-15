import Link from 'next/link';
import { GIWA_FAUCET_URL } from '../lib/botPublic';

export function SiteFooter({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <footer className="mt-auto border-t border-border">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 py-12 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-sans text-sm tracking-[0.16em] text-paper">FLIZY</p>
          <p className="mt-2 max-w-sm text-sm text-muted">
            Chat wallet for WhatsApp and Telegram. Trusted sends. Built for GIWA and EVM.
          </p>
        </div>
        <div className="flex flex-wrap gap-5 text-sm text-muted">
          <Link href="/how-it-works" className="text-muted no-underline hover:text-lime">
            Guide
          </Link>
          <a
            href={GIWA_FAUCET_URL}
            className="text-muted no-underline hover:text-lime"
            target="_blank"
            rel="noreferrer"
          >
            GIWA faucet
          </a>
          <Link href="/docs" className="text-muted no-underline hover:text-lime">
            Docs
          </Link>
          <Link href="/terms" className="text-muted no-underline hover:text-lime">
            Terms
          </Link>
          <Link href="/privacy" className="text-muted no-underline hover:text-lime">
            Privacy
          </Link>
          <a
            href="https://x.com/Flizyapp"
            className="text-muted no-underline hover:text-lime"
            target="_blank"
            rel="noreferrer"
          >
            X
          </a>
          {signedIn ? null : (
            <Link href="/signup" className="text-muted no-underline hover:text-lime">
              Signup
            </Link>
          )}
          <Link href="/dashboard" className="text-muted no-underline hover:text-lime">
            App
          </Link>
        </div>
      </div>
    </footer>
  );
}
