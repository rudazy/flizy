/**
 * Card art without an image.
 *
 * There is no upload capability in this product: no storage bucket, no upload
 * route, no file input. Rather than accept a third-party image URL, which means
 * loading arbitrary hosts into the page and a broken card the day that host goes
 * away, the art is derived from the task itself.
 *
 * Deterministic on purpose. The same task always looks the same, so the card
 * becomes recognisable the second time somebody scrolls past it, which is most of
 * what a cover image was doing.
 *
 * Only the existing palette tokens are used, so a task cannot introduce a colour
 * the rest of the product does not have.
 */

/** Two angles and a tint, chosen from the ref. Small set, so it stays coherent. */
const TINTS = [
  'from-lime/25 via-surface to-ink',
  'from-gold/25 via-surface to-ink',
  'from-copper/25 via-surface to-ink',
  'from-lime/15 via-gold/10 to-ink',
  'from-gold/15 via-copper/10 to-ink',
] as const;

const ANGLES = ['bg-gradient-to-br', 'bg-gradient-to-tr', 'bg-gradient-to-r'] as const;

/**
 * The prop is `taskRef`, not `ref`.
 *
 * `ref` is reserved: React intercepts it, and a Server Component refuses to pass
 * one at all, so the public task page answered 500 with "Refs cannot be used in
 * Server Components" while every type check and build stayed green. Naming a
 * domain field after a React internal is the whole bug.
 */
export function TaskCardArt({
  taskRef,
  label,
  className = '',
}: {
  taskRef: number;
  label: string;
  className?: string;
}) {
  // A ref is a small integer and these are small sets, so plain arithmetic is
  // enough: no hashing, nothing to get subtly wrong.
  const tint = TINTS[taskRef % TINTS.length];
  const angle = ANGLES[taskRef % ANGLES.length];

  const monogram = initialsFrom(label);

  return (
    <div
      className={`relative flex h-32 w-full items-end overflow-hidden rounded-t-md border-b border-border ${angle} ${tint} ${className}`}
      aria-hidden
    >
      {/* A faint grid, so the surface reads as built rather than as a swatch. */}
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)',
          backgroundSize: '18px 18px',
        }}
      />
      <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-ink to-transparent" />
      <span className="relative select-none px-4 pb-3 font-sans text-3xl font-semibold tracking-wide text-paper/20">
        {monogram}
      </span>
    </div>
  );
}

/** Up to two initials from a title, for the monogram. */
function initialsFrom(label: string): string {
  const words = String(label || '')
    .trim()
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  if (!words.length) return 'FZ';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
