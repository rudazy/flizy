/**
 * The verification badge, in the accent colour: Flizy verified the token.
 * Which tokens can be sent on socials is a separate, fixed list (ETH and FLZ).
 */
export function VerifiedMark() {
  return (
    <span className="inline-flex shrink-0 text-sun" title="Verified" role="img" aria-label="Verified">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="7" fill="currentColor" />
        <path
          d="M4 7.2 6.1 9.2 10 4.8"
          fill="none"
          stroke="#1a1405"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
