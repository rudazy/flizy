/**
 * Line icons for Explore and the app chrome. Inline SVG on a 24 grid, drawn in
 * currentColor, so each takes the text colour of whatever it sits in.
 */

type IconProps = { size?: number; strokeWidth?: number; className?: string };

function Svg({
  size = 18,
  className,
  children,
}: {
  size?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function TasksIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <rect x="5" y="4.5" width="14" height="16.5" rx="2" />
        <rect x="9" y="2.5" width="6" height="3.5" rx="1" />
        <path d="M9 13.2l2.1 2.1L15.2 11" />
      </g>
    </Svg>
  );
}

export function TokensIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <ellipse cx="12" cy="6" rx="7" ry="2.6" />
        <path d="M5 6v12c0 1.45 3.13 2.6 7 2.6s7-1.15 7-2.6V6" />
        <path d="M5 10c0 1.45 3.13 2.6 7 2.6s7-1.15 7-2.6" />
        <path d="M5 14c0 1.45 3.13 2.6 7 2.6s7-1.15 7-2.6" />
      </g>
    </Svg>
  );
}

export function NftsIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <rect x="3.5" y="4" width="17" height="16" rx="2.2" />
        <circle cx="9" cy="9.5" r="1.7" />
        <path d="M4 17.5l4.6-4.6 3.6 3.6 2.4-2.4 5.4 5" />
      </g>
    </Svg>
  );
}

export function SearchIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <circle cx="10.8" cy="10.8" r="6.3" />
        <path d="M15.6 15.6L20 20" />
      </g>
    </Svg>
  );
}

export function BellIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M6.2 16.5V10.8a5.8 5.8 0 0 1 11.6 0v5.7l1.4 1.7H4.8l1.4-1.7z" />
        <path d="M10 20.3a2.1 2.1 0 0 0 4 0" />
      </g>
    </Svg>
  );
}

export function PlusIcon({ size, strokeWidth = 2, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function BoltIcon({ size, className }: IconProps) {
  return (
    <svg width={size ?? 12} height={size ?? 12} viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="currentColor" d="M13.5 2L4.5 13.6h6.3L9.8 22l9.2-12.1h-6.4L13.5 2z" />
    </svg>
  );
}

export function ArrowRightIcon({ size, strokeWidth = 2, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M4.5 12h14.5M13.5 6.5L19 12l-5.5 5.5" />
    </Svg>
  );
}

export function AirdropIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M3.5 10.5a8.5 7.5 0 0 1 17 0" />
        <path d="M3.5 10.5c1.4-1.3 2.9-1.3 4.3 0 1.4-1.3 2.8-1.3 4.2 0 1.4-1.3 2.8-1.3 4.2 0 1.4-1.3 2.9-1.3 4.3 0" />
        <path d="M3.8 10.8l7 7.4M20.2 10.8l-7 7.4M12 10.5v7.7" />
        <rect x="10.3" y="18.2" width="3.4" height="3" rx="0.6" />
      </g>
    </Svg>
  );
}

export function SocialIcon({ size, className }: IconProps) {
  return (
    <svg width={size ?? 18} height={size ?? 18} viewBox="0 0 24 24" className={className} aria-hidden>
      <g fill="currentColor">
        <circle cx="9" cy="8" r="3.4" />
        <path d="M2.6 19.4c.5-3.6 3.1-5.8 6.4-5.8s5.9 2.2 6.4 5.8c.05.4-.25.7-.65.7H3.25c-.4 0-.7-.3-.65-.7z" />
        <circle cx="16.8" cy="9" r="2.6" />
        <path d="M16.2 13.1c2.9-.4 5.1 1.5 5.5 4.6.05.4-.25.7-.65.7h-3.6c-.2-2.1-.7-3.6-1.9-4.9.2-.2.4-.3.65-.4z" />
      </g>
    </svg>
  );
}

export function OnchainIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M10.2 13.8a4 4 0 0 0 5.7 0l2.9-2.9a4 4 0 0 0-5.7-5.7l-1.2 1.2" />
        <path d="M13.8 10.2a4 4 0 0 0-5.7 0l-2.9 2.9a4 4 0 0 0 5.7 5.7l1.2-1.2" />
      </g>
    </Svg>
  );
}

export function ContentIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M6.5 2.8h7.3l4.7 4.7v12.7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.8a1 1 0 0 1 1-1z" />
        <path d="M13.5 3v4.8h4.8" />
        <path d="M9 12.5h6M9 16h6" />
      </g>
    </Svg>
  );
}

export function PartnerIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M2.5 9.5l3-3 3.2 1.2" />
        <path d="M21.5 9.5l-3-3-4.5 1.4-3.3 2.6a1.4 1.4 0 0 0 1.8 2.1l2.3-1.4 4.2 4.1" />
        <path d="M2.8 9.6l2.4 5 1.4-.9" />
        <path d="M21.2 9.6l-2.4 5" />
        <path d="M6.6 13.7l1.9 1.9a1.3 1.3 0 0 0 1.9 0l.2-.2M9.5 16.8l.9.9a1.3 1.3 0 0 0 1.9 0l.3-.3M12.5 17.6l.6.6a1.3 1.3 0 0 0 1.9 0l3.8-3.6" />
      </g>
    </Svg>
  );
}

export function HistoryIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M4.2 12a7.8 7.8 0 1 0 2.3-5.5L4 9" />
        <path d="M4 4.5V9h4.5" />
        <path d="M12 8v4.3l2.9 1.8" />
      </g>
    </Svg>
  );
}
