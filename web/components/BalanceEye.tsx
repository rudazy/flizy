'use client';

/** Line icon. Open while a figure is visible. One stroke across it when the figure is covered. */
export function EyeMark({
  hidden,
  className = 'h-4 w-4',
}: {
  hidden: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.75 12S6.1 6.6 12 6.6 21.25 12 21.25 12 17.9 17.4 12 17.4 2.75 12 2.75 12Z" />
      {hidden ? (
        <path d="M5 17.25 19 6.75" />
      ) : (
        <circle cx="12" cy="12" r="2.15" strokeWidth="1.75" />
      )}
    </svg>
  );
}
