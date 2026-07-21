'use client';

export function AccordionSection({
  id,
  title,
  badge,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  badge?: string;
  open: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-white/[0.02]"
        onClick={() => onToggle(id)}
        aria-expanded={open}
      >
        <span className="font-sans text-base tracking-wide text-paper">{title}</span>
        <span className="flex items-center gap-3">
          {badge ? <span className="badge badge-lime">{badge}</span> : null}
          <span className="text-muted" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
        </span>
      </button>
      {open ? <div className="border-t border-border px-5 py-5">{children}</div> : null}
    </section>
  );
}
