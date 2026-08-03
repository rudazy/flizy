/**
 * Structure-only layout primitives (LAYOUT.md).
 * Colors stay Flizy tokens. Sections on multi-mode screens are SLIDES:
 * chip selects one panel; only that panel’s content is shown — no scroll-to-anchor.
 */

'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/** Page column rhythm */
export function AppPage({ children }: { children: ReactNode }) {
  return <div className="space-y-4 pb-2">{children}</div>;
}

export type SlideNavItem = { id: string; label: string; badge?: string };

/**
 * Secondary mode chips: switch which slide is on screen.
 * Not hash links — do not jump down a long page.
 */
export function AppSlideNav({
  items,
  activeId,
  onSelect,
}: {
  items: SlideNavItem[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      className="flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="Sections"
      role="tablist"
    >
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(item.id)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-sans text-[11px] tracking-wide transition-colors ${
              active
                ? 'border-lime/40 bg-lime/10 text-lime'
                : 'border-border bg-surface text-muted hover:border-[#3a322a] hover:text-paper'
            }`}
          >
            {item.label}
            {item.badge ? (
              <span
                className={`font-mono text-[10px] ${active ? 'text-lime' : 'text-muted'}`}
              >
                {item.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * URL-synced slide state: ?s=slideId.
 * Deep links open the right panel without stacking everything below.
 */
export function useSlide(
  validIds: readonly string[],
  defaultId: string
): [string, (id: string) => void] {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() || '';

  const activeId = useMemo(() => {
    const raw = search.get('s') || '';
    if (validIds.includes(raw)) return raw;
    return defaultId;
  }, [search, validIds, defaultId]);

  const setSlide = useCallback(
    (id: string) => {
      if (!validIds.includes(id)) return;
      const params = new URLSearchParams(search.toString());
      if (id === defaultId) {
        params.delete('s');
      } else {
        params.set('s', id);
      }
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [validIds, defaultId, search, router, pathname]
  );

  return [activeId, setSlide];
}

/** @deprecated Use AppSlideNav — hash jump chips were the wrong model */
export function AppSectionNav({
  items,
}: {
  items: Array<{ id: string; label: string; badge?: string }>;
}) {
  return (
    <AppSlideNav
      items={items}
      activeId={items[0]?.id || ''}
      onSelect={() => {
        /* no-op shell if something still imports this; pages should use AppSlideNav */
      }}
    />
  );
}

/** Subsection card: title · helper · badge · body (one slide’s content) */
export function AppSection({
  id,
  title,
  helper,
  badge,
  badgeTone,
  children,
  className = '',
}: {
  id?: string;
  title: string;
  helper?: string;
  badge?: string;
  badgeTone?: 'default' | 'gold' | 'lime';
  children: ReactNode;
  className?: string;
}) {
  const badgeClass =
    badgeTone === 'gold' ? 'badge badge-gold' : badgeTone === 'lime' ? 'badge badge-lime' : 'badge';

  return (
    <section id={id} className={`card p-4 sm:p-5 ${className}`.trim()} role="tabpanel">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-sans text-sm tracking-wide text-paper">{title}</p>
          {helper ? (
            <p className="mt-1 text-xs leading-relaxed text-muted">{helper}</p>
          ) : null}
        </div>
        {badge ? <span className={`${badgeClass} shrink-0`}>{badge}</span> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Compact status strip (Home top) */
export function AppStatusStrip({ children }: { children: ReactNode }) {
  return (
    <section className="card grid grid-cols-2 gap-0 overflow-hidden sm:grid-cols-4">
      {children}
    </section>
  );
}

export function AppStatusCell({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}) {
  const inner = (
    <>
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className="mt-1 truncate font-sans text-sm tracking-wide text-paper">{value}</p>
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        className="border-b border-r border-border px-3 py-3 no-underline last:border-r-0 hover:bg-white/[0.02] sm:border-b-0"
      >
        {inner}
      </Link>
    );
  }
  return (
    <div className="border-b border-r border-border px-3 py-3 last:border-r-0 sm:border-b-0">
      {inner}
    </div>
  );
}

/** Quick action grid — each item should open a real destination or slide (?s=) */
export function AppQuickActions({
  items,
}: {
  items: Array<{ href: string; label: string; hint?: string }>;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => (
        <Link
          key={item.href + item.label}
          href={item.href}
          className="card flex flex-col justify-center px-3 py-3 no-underline transition-colors hover:border-[#3a322a]"
        >
          <span className="font-sans text-sm tracking-wide text-paper">{item.label}</span>
          {item.hint ? (
            <span className="mt-0.5 font-mono text-[10px] text-muted">{item.hint}</span>
          ) : null}
        </Link>
      ))}
    </div>
  );
}

/** List row for attention / setup */
export function AppListRow({
  title,
  body,
  done,
  href,
  actionLabel = 'Open',
}: {
  title: string;
  body: string;
  done?: boolean;
  href?: string;
  actionLabel?: string;
}) {
  return (
    <li className="flex items-start gap-3 border-b border-border py-3 first:pt-0 last:border-0 last:pb-0">
      <span
        className={`mt-0.5 font-mono text-[11px] ${done ? 'text-lime' : 'text-muted'}`}
        aria-hidden
      >
        {done ? '[x]' : '[ ]'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-sans text-sm tracking-wide text-paper">{title}</p>
        <p className="mt-0.5 text-xs text-muted">{body}</p>
      </div>
      {href && !done ? (
        <Link href={href} className="shrink-0 text-xs text-lime no-underline hover:text-gold">
          {actionLabel}
        </Link>
      ) : null}
    </li>
  );
}
