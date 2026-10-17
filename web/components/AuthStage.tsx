/**
 * Line drawing for the wide login and signup screens.
 * Gold and neutral only. No app-icon discs and no flag marks.
 */
export function AuthStage({ variant }: { variant: 'login' | 'signup' }) {
  return (
    <div className="relative mt-4 h-[220px] w-[300px]" aria-hidden>
      <svg viewBox="0 0 420 240" className="h-full w-full" fill="none">
        <ellipse cx="150" cy="198" rx="78" ry="8" stroke="#3a3228" />
        <ellipse cx="150" cy="198" rx="46" ry="4" stroke="#f7d047" strokeOpacity="0.45" />
        {variant === 'signup' ? <PhoneMark /> : <TileCluster />}
      </svg>
    </div>
  );
}

function PhoneMark() {
  return (
    <g>
      <rect x="124" y="42" width="88" height="148" rx="16" stroke="#f7d047" strokeWidth="1.4" />
      <rect x="132" y="54" width="72" height="116" rx="8" stroke="#c8c2b8" strokeOpacity="0.35" />
      <text
        x="168"
        y="124"
        textAnchor="middle"
        fill="#f7d047"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="36"
        fontWeight="600"
      >
        F
      </text>
      <Medallion cx={92} cy={78} />
      <Medallion cx={248} cy={70} />
      <Medallion cx={256} cy={156} />
    </g>
  );
}

function TileCluster() {
  return (
    <g>
      <rect x="112" y="58" width="112" height="112" rx="18" stroke="#f7d047" strokeWidth="1.4" />
      <text
        x="168"
        y="128"
        textAnchor="middle"
        fill="#f7d047"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="42"
        fontWeight="600"
      >
        F
      </text>
      <Medallion cx={78} cy={86} />
      <Medallion cx={252} cy={78} />
      <Medallion cx={246} cy={164} />
    </g>
  );
}

function Medallion({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r="16" stroke="#f7d047" strokeOpacity="0.7" />
      <path
        d={`M${cx} ${cy - 5} L${cx + 4} ${cy} L${cx} ${cy + 5} L${cx - 4} ${cy} Z`}
        stroke="#f7d047"
        strokeOpacity="0.9"
      />
    </g>
  );
}
