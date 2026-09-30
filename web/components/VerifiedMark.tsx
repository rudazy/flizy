/**
 * The verification badge. Blue, because a verified token can be sent on
 * socials. This is the one blue mark in the product.
 */
export function VerifiedMark() {
  return (
    <span className="inline-flex shrink-0 text-[#1d9bf0]" title="Verified" role="img" aria-label="Verified">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="7" fill="currentColor" />
        <path
          d="M4 7.2 6.1 9.2 10 4.8"
          fill="none"
          stroke="#f2ebe1"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
