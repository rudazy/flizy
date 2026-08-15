import Link from 'next/link';

export function SiteHeader({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/80 bg-ink/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-4">
        <Link href={signedIn ? '/dashboard' : '/'} className="flex items-center gap-3 no-underline">
          <span className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface font-sans text-lg font-semibold text-lime shadow-glow">
            F
          </span>
          <span className="font-sans text-sm font-semibold tracking-[0.18em] text-paper">FLIZY</span>
        </Link>
        <nav className="flex flex-wrap items-center justify-end gap-0.5 text-xs sm:gap-1 sm:text-sm">
          <Link href="/how-it-works" className="nav-link">
            Guide
          </Link>
          <Link href="/docs" className="nav-link hidden sm:inline-flex">
            Docs
          </Link>
          {signedIn ? (
            <Link
              href="/dashboard"
              className="btn btn-primary ml-1 no-underline !px-2.5 !py-1.5 text-xs sm:ml-2 sm:!px-3 sm:!py-2 sm:text-sm"
            >
              App
            </Link>
          ) : (
            <>
              <Link href="/dashboard" className="nav-link">
                App
              </Link>
              <Link href="/login" className="nav-link">
                Log in
              </Link>
              <Link
                href="/signup"
                className="btn btn-primary ml-1 no-underline !px-2.5 !py-1.5 text-xs sm:ml-2 sm:!px-3 sm:!py-2 sm:text-sm"
              >
                Get started
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
