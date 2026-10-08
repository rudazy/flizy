import { ShieldCheckIcon } from './ExploreIcons';

/**
 * The mark beside a project Flizy has verified. Rendered only while
 * projects.verified_at is set, which no route can write.
 */
export function VerifiedBadge({ size = 14 }: { size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center text-lime" title="Verified by Flizy">
      <ShieldCheckIcon size={size} />
      <span className="sr-only">Verified by Flizy</span>
    </span>
  );
}
