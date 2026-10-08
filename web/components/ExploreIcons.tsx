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

/** Pulse trace for the Wallet Scan tab. */
export function ScanIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M3 12h3.2l2.2-5.2 3.2 10.4 2.4-5.2H21" />
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

export function ArrowLeftIcon({ size, strokeWidth = 2, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M19.5 12H5M10.5 6.5L5 12l5.5 5.5" />
    </Svg>
  );
}

export function HelpIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8" />
        <path d="M12 17.2h.01" strokeWidth={2.4} />
      </g>
    </Svg>
  );
}

export function PersonIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <circle cx="12" cy="8" r="3.8" />
        <path d="M4.8 20.2c.9-3.7 3.6-5.6 7.2-5.6s6.3 1.9 7.2 5.6" />
      </g>
    </Svg>
  );
}

export function PeopleIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <circle cx="9" cy="8.2" r="3.4" />
        <path d="M2.8 19.6c.8-3.4 3.1-5.1 6.2-5.1s5.4 1.7 6.2 5.1" />
        <path d="M15.2 4.9a3.3 3.3 0 0 1 0 6.5" />
        <path d="M17.6 14.6c1.9.6 3.2 2.3 3.6 5" />
      </g>
    </Svg>
  );
}

export function ClockIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <circle cx="12" cy="12" r="8.8" />
        <path d="M12 7.2V12l3.2 2" />
      </g>
    </Svg>
  );
}

export function CalendarIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <rect x="3.8" y="5" width="16.4" height="15.5" rx="2" />
        <path d="M3.8 9.8h16.4M8.2 3v4M15.8 3v4" />
        <path d="M7.6 13.4h.01M12 13.4h.01M16.4 13.4h.01M7.6 17h.01M12 17h.01" strokeWidth={2.2} />
      </g>
    </Svg>
  );
}

export function ChevronDownIcon({ size, strokeWidth = 2, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M6.5 9.5L12 15l5.5-5.5" />
    </Svg>
  );
}

export function InfoIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <circle cx="12" cy="12" r="8.8" />
        <path d="M12 11v5.4" />
        <path d="M12 7.8h.01" strokeWidth={2.4} />
      </g>
    </Svg>
  );
}

/** The X (Twitter) mark, as a requirement type. */
export function XLogoIcon({ size, className }: IconProps) {
  return (
    <svg width={size ?? 18} height={size ?? 18} viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        fill="currentColor"
        d="M17.75 3h3.07l-6.72 7.68L22 21h-6.19l-4.85-6.34L5.4 21H2.33l7.19-8.21L1.94 3h6.35l4.38 5.79L17.75 3zm-1.08 16.17h1.7L7.4 4.73H5.58l11.09 14.44z"
      />
    </svg>
  );
}

export function ListIcon({ size, strokeWidth = 1.9, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M9 6.5h11M9 12h11M9 17.5h11" />
        <path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" strokeWidth={2.8} />
      </g>
    </Svg>
  );
}

export function EyeIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M2.5 12s3.4-6.5 9.5-6.5S21.5 12 21.5 12s-3.4 6.5-9.5 6.5S2.5 12 2.5 12z" />
        <circle cx="12" cy="12" r="2.8" />
      </g>
    </Svg>
  );
}

export function TrashIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M4 6.5h16M9.5 6.5V4.2h5v2.3" />
        <path d="M6.2 6.5l.9 13.3a1 1 0 0 0 1 .9h7.8a1 1 0 0 0 1-.9l.9-13.3" />
        <path d="M10 10.5v6.5M14 10.5v6.5" />
      </g>
    </Svg>
  );
}

export function InfinityIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path
        strokeWidth={strokeWidth}
        d="M12 12c-1.8-2.4-3.4-3.6-5.2-3.6a3.6 3.6 0 0 0 0 7.2c1.8 0 3.4-1.2 5.2-3.6zm0 0c1.8 2.4 3.4 3.6 5.2 3.6a3.6 3.6 0 0 0 0-7.2c-1.8 0-3.4 1.2-5.2 3.6z"
      />
    </Svg>
  );
}

export function WalletIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h10A1.5 1.5 0 0 1 18 6.5V8" />
        <rect x="4" y="8" width="16.5" height="11.5" rx="2.2" />
        <path d="M15.5 13.75h2" strokeWidth={2.4} />
      </g>
    </Svg>
  );
}

export function PlusCircleIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <circle cx="12" cy="12" r="8.8" />
        <path d="M12 8v8M8 12h8" />
      </g>
    </Svg>
  );
}

export function RefreshIcon({ size, strokeWidth = 2, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
        <path d="M19.6 4.2v4.3h-4.3" />
      </g>
    </Svg>
  );
}

export function CopyIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <rect x="8" y="7.5" width="11" height="13" rx="2" />
        <path d="M5 16.5V5.5a2 2 0 0 1 2-2h8" />
      </g>
    </Svg>
  );
}

export function ExternalLinkIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M18.5 13.5v5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5V7a1.5 1.5 0 0 1 1.5-1.5h5" />
        <path d="M14 4h6v6M20 4l-9 9" />
      </g>
    </Svg>
  );
}

export function ChevronRightIcon({ size, strokeWidth = 2, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M9.5 6.5L15 12l-5.5 5.5" />
    </Svg>
  );
}

/** Ether's diamond, drawn flat in currentColor. */
export function EthDiamondIcon({ size, className }: IconProps) {
  return (
    <svg width={size ?? 18} height={size ?? 18} viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="currentColor" opacity="0.65" d="M12 2.5l-6 9.8 6 3.5 6-3.5z" />
      <path fill="currentColor" d="M12 2.5v13.3l6-3.5z" />
      <path fill="currentColor" opacity="0.65" d="M6 13.5l6 8 6-8-6 3.6z" />
      <path fill="currentColor" d="M12 17.1v4.4l6-8z" />
    </svg>
  );
}

/** The GIWA wave mark: three stacked swells. */
export function GiwaMarkIcon({ size, className }: IconProps) {
  return (
    <svg width={size ?? 24} height={size ?? 24} viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        fill="currentColor"
        d="M3 6.2c3-2.4 6.2-2.4 9 0 2.8 2.3 5.7 2.3 9 0v3c-3.3 2.3-6.2 2.3-9 0-2.8-2.3-6-2.3-9 0zM3 11.2c3-2.4 6.2-2.4 9 0 2.8 2.3 5.7 2.3 9 0v3c-3.3 2.3-6.2 2.3-9 0-2.8-2.3-6-2.3-9 0zM3 16.2c3-2.4 6.2-2.4 9 0 2.8 2.3 5.7 2.3 9 0v3c-3.3 2.3-6.2 2.3-9 0-2.8-2.3-6-2.3-9 0z"
      />
    </svg>
  );
}

export function ArrowDownIcon({ size, strokeWidth = 1.9, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M12 4v13M6.5 11.5L12 17l5.5-5.5" />
        <path d="M5 20.5h14" />
      </g>
    </Svg>
  );
}

export function SwapArrowsIcon({ size, strokeWidth = 1.9, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M4.5 8.5h14M15 5l3.5 3.5L15 12" />
        <path d="M19.5 15.5h-14M9 12l-3.5 3.5L9 19" />
      </g>
    </Svg>
  );
}

export function UserPlusIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <circle cx="10" cy="8" r="3.6" />
        <path d="M3.5 20c.8-3.6 3.3-5.4 6.5-5.4 1.6 0 3 .4 4.1 1.2" />
        <path d="M18 14v6M15 17h6" />
      </g>
    </Svg>
  );
}

export function AlertCircleIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <circle cx="12" cy="12" r="8.8" />
        <path d="M12 7.6v5.2" />
        <path d="M12 16.2h.01" strokeWidth={2.6} />
      </g>
    </Svg>
  );
}

export function CheckIcon({ size, strokeWidth = 2.2, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M5.5 12.5l4.2 4.2L18.5 7.8" />
    </Svg>
  );
}

export function ChartLineIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M3.5 4v16.5H21" />
        <path d="M6.5 16l4.2-5 3.3 3 5.5-7" />
      </g>
    </Svg>
  );
}

export function GearIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2.8l1.6 2.4 2.8-.7.7 2.8 2.4 1.6-1.2 2.6 1.2 2.6-2.4 1.6-.7 2.8-2.8-.7L12 21.2l-1.6-2.4-2.8.7-.7-2.8-2.4-1.6 1.2-2.6-1.2-2.6 2.4-1.6.7-2.8 2.8.7z" />
      </g>
    </Svg>
  );
}

export function PencilIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M4 20l1-4.2L15.7 5.1a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.2 19 4 20z" />
        <path d="M13.8 7l3.2 3.2" />
      </g>
    </Svg>
  );
}

export function ShieldCheckIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M12 3l7.5 2.8v5.6c0 4.6-3.1 8.2-7.5 9.6-4.4-1.4-7.5-5-7.5-9.6V5.8L12 3z" />
        <path d="M8.6 12.2l2.4 2.4 4.4-4.6" />
      </g>
    </Svg>
  );
}

export function LockIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <rect x="5" y="10.5" width="14" height="10" rx="2" />
        <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
        <path d="M12 14.6v2" />
      </g>
    </Svg>
  );
}

export function SwapVerticalIcon({ size, strokeWidth = 2, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M8 19V5M4.5 8.5L8 5l3.5 3.5" />
        <path d="M16 5v14M12.5 15.5L16 19l3.5-3.5" />
      </g>
    </Svg>
  );
}

export function BookOpenIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M12 6.5C10.3 5.2 7.9 4.6 3.5 4.8v13.4c4.4-.2 6.8.4 8.5 1.7 1.7-1.3 4.1-1.9 8.5-1.7V4.8c-4.4-.2-6.8.4-8.5 1.7z" />
        <path d="M12 6.5v13.4" />
      </g>
    </Svg>
  );
}

export function MoreVerticalIcon({ size, className }: IconProps) {
  return (
    <svg width={size ?? 18} height={size ?? 18} viewBox="0 0 24 24" className={className} aria-hidden>
      <g fill="currentColor">
        <circle cx="12" cy="5.5" r="2" />
        <circle cx="12" cy="12" r="2" />
        <circle cx="12" cy="18.5" r="2" />
      </g>
    </svg>
  );
}

/** A filled flame in gold to orange, for the token list heading. */
export function FlameIcon({ size, className }: IconProps) {
  return (
    <svg width={size ?? 18} height={size ?? 18} viewBox="0 0 24 24" className={className} aria-hidden>
      <defs>
        <linearGradient id="flame-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd25a" />
          <stop offset="1" stopColor="#f2702a" />
        </linearGradient>
      </defs>
      <path
        fill="url(#flame-fill)"
        d="M12.6 2.5c.4 2.6-.6 4.4-2 6-1.5 1.6-3.6 3.4-3.6 6.6A5.1 5.1 0 0 0 12 20.5a5.2 5.2 0 0 0 5.3-5.3c0-2.2-1-3.7-1.9-4.9-.2 1.4-.9 2.5-2 3 .4-2.9-.2-6.9-.8-10.8z"
      />
      <path fill="#ffe58a" d="M12.2 13.2c.9 1.3 1.8 2.3 1.8 3.7a2 2 0 0 1-4 0c0-1.3.9-2.3 2.2-3.7z" />
    </svg>
  );
}

export function HeartIcon({ size, strokeWidth = 1.8, className, filled = false }: IconProps & { filled?: boolean }) {
  return (
    <Svg size={size} className={className}>
      <path
        strokeWidth={strokeWidth}
        fill={filled ? 'currentColor' : 'none'}
        d="M12 20s-7.5-4.4-7.5-10.1A4.4 4.4 0 0 1 12 7.1a4.4 4.4 0 0 1 7.5 2.8C19.5 15.6 12 20 12 20z"
      />
    </Svg>
  );
}

export function CartIcon({ size, strokeWidth = 1.9, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M3 4h2.2l2.2 10.4a1.5 1.5 0 0 0 1.5 1.2h8.3a1.5 1.5 0 0 0 1.5-1.1L20.5 8H6.1" />
        <path d="M9.5 20h.01M17 20h.01" strokeWidth={2.8} />
      </g>
    </Svg>
  );
}

export function TagIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l8 8a1.4 1.4 0 0 1 0 2l-6.1 6.1a1.4 1.4 0 0 1-2 0z" />
        <path d="M8 8h.01" strokeWidth={2.8} />
      </g>
    </Svg>
  );
}

export function FilterIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M4 6h16M7 12h10M10 18h4" />
    </Svg>
  );
}

export function SortIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M7 4v16M3.5 16.5L7 20l3.5-3.5M17 20V4M13.5 7.5L17 4l3.5 3.5" />
    </Svg>
  );
}

export function GridIcon({ size, strokeWidth = 1.8, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" />
        <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2" />
        <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2" />
        <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2" />
      </g>
    </Svg>
  );
}

export function GlobeIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z" />
      </g>
    </Svg>
  );
}

export function CloseIcon({ size, strokeWidth = 2, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function TrophyIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <path d="M8 4h8v5a4 4 0 0 1-8 0V4z" />
        <path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4" />
        <path d="M12 13v4M9 20h6M10 17h4" />
      </g>
    </Svg>
  );
}

export function GiftIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <rect x="4" y="9" width="16" height="11" rx="1.5" />
        <path d="M3 9h18M12 9v11" />
        <path d="M12 9c-1.5-3-5-4-5.5-2s2.5 2 5.5 2zM12 9c1.5-3 5-4 5.5-2S15 9 12 9z" />
      </g>
    </Svg>
  );
}

export function ShareIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <g strokeWidth={strokeWidth}>
        <circle cx="18" cy="5.5" r="2.5" />
        <circle cx="6" cy="12" r="2.5" />
        <circle cx="18" cy="18.5" r="2.5" />
        <path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1" />
      </g>
    </Svg>
  );
}

export function CrownIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M4 17h16l-1.5-9-4.5 4-2-6-2 6-4.5-4L4 17zM5 20h14" />
    </Svg>
  );
}

export function StarIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z" />
    </Svg>
  );
}

export function PaperPlaneIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path strokeWidth={strokeWidth} d="M21 4 3.5 10.5l6.2 2.3L17 7.5l-5.2 7.1 2.2 6.1L21 4z" />
    </Svg>
  );
}

export function GithubIcon({ size, strokeWidth = 1.7, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path
        strokeWidth={strokeWidth}
        d="M9 19c-4 1.3-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"
      />
    </Svg>
  );
}
