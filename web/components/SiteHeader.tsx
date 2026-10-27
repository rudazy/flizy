import Link from 'next/link';

export function SiteHeader({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/80 bg-ink/85 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-[1200px] items-center justify-between gap-2 px-3 py-3 sm:gap-4 sm:px-6 sm:py-4">
        <Link href={signedIn ? '/dashboard' : '/'} className="flex shrink-0 items-center gap-2 no-underline sm:gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface font-sans text-lg font-semibold text-lime shadow-glow">
            F
          </span>
          <span className="font-sans text-[13px] font-semibold tracking-[0.14em] text-paper sm:text-sm sm:tracking-[0.18em]">
            FLIZY
          </span>
        </Link>
        <nav className="flex shrink-0 items-center justify-end text-[11px] sm:gap-1 sm:text-sm">
          <Link href="/how-it-works" className="nav-link !hidden !px-1.5 min-[360px]:!inline-flex sm:!px-[0.7rem]">
            Guide
          </Link>
          {/* Plain hidden loses to .nav-link, which sets display later in globals.css. */}
          <Link href="/docs" className="nav-link !hidden sm:!inline-flex">
            Docs
          </Link>
          {signedIn ? (
            <Link
              href="/dashboard"
              className="btn btn-primary ml-1 no-underline !px-2 !py-1.5 !text-[11px] sm:ml-2 sm:!px-3 sm:!py-2 sm:!text-sm"
            >
              App
            </Link>
          ) : (
            <>
              <Link href="/dashboard" className="nav-link !px-1.5 sm:!px-[0.7rem]">
                App
              </Link>
              <Link href="/login" className="nav-link !px-1.5 sm:!px-[0.7rem]">
                Log in
              </Link>
              <Link
                href="/signup"
                className="btn btn-primary ml-1 whitespace-nowrap no-underline !px-2 !py-1.5 !text-[11px] sm:ml-2 sm:!px-3 sm:!py-2 sm:!text-sm"
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
