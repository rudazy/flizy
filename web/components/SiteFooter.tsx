import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 py-12 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-sans text-sm tracking-[0.16em] text-paper">FLIZY</p>
          <p className="mt-2 max-w-sm text-sm text-muted">
            WhatsApp-native wallet. Trusted sends. Built for GIWA and EVM.
          </p>
        </div>
        <div className="flex flex-wrap gap-5 text-sm text-muted">
          <Link href="/how-it-works" className="text-muted no-underline hover:text-lime">
            Guide
          </Link>
          <a
            href="https://bridge-giwa.vercel.app/"
            className="text-muted no-underline hover:text-lime"
            target="_blank"
            rel="noreferrer"
          >
            Bridge
          </a>
          <a
            href="https://cloud.google.com/application/web3/faucet"
            className="text-muted no-underline hover:text-lime"
            target="_blank"
            rel="noreferrer"
          >
            Faucet
          </a>
          <Link href="/docs" className="text-muted no-underline hover:text-lime">
            Security
          </Link>
          <Link href="/signup" className="text-muted no-underline hover:text-lime">
            Signup
          </Link>
          <Link href="/dashboard" className="text-muted no-underline hover:text-lime">
            App
          </Link>
        </div>
      </div>
    </footer>
  );
}
