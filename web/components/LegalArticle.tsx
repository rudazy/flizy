import Link from 'next/link';
import type { ReactNode } from 'react';

export function LegalArticle({
  eyebrow,
  title,
  updated,
  otherHref,
  otherLabel,
  children,
}: {
  eyebrow: string;
  title: string;
  updated: string;
  otherHref: string;
  otherLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="fade-up mx-auto max-w-3xl space-y-8">
      <nav className="text-xs text-muted" aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1.5">
          <li>
            <Link href="/" className="text-muted no-underline hover:text-lime">
              Home
            </Link>
          </li>
          <li aria-hidden className="text-border">
            /
          </li>
          <li className="text-paper">{title}</li>
        </ol>
      </nav>

      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-gold">{eyebrow}</p>
        <h1 className="mt-3 font-sans text-3xl tracking-wide text-paper sm:text-4xl">{title}</h1>
        <p className="mt-3 text-sm text-muted">Last updated {updated}</p>
      </div>

      <div className="space-y-8 text-sm leading-relaxed text-muted sm:text-base">{children}</div>

      <p className="text-sm text-muted">
        Also see{' '}
        <Link href={otherHref} className="text-paper no-underline hover:text-lime">
          {otherLabel}
        </Link>
        .
      </p>
    </div>
  );
}

export function LegalH({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="font-sans text-xl tracking-wide text-paper">
      {children}
    </h2>
  );
}
