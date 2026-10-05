'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  BoltIcon,
  ChevronRightIcon,
  CopyIcon,
  GearIcon,
  GiwaMarkIcon,
  HelpIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  SwapArrowsIcon,
  TokensIcon,
} from './ExploreIcons';
import { splitWalletPaste } from '../lib/copyPaste';
import {
  formatCompactUsd,
  formatUsdFromCents,
  formFromRules,
  overrideFormFrom,
  overridePayload,
  resolveWallet,
  type CopyTradeRules,
  type OverrideForm,
  type RuleForm,
  type WalletOverride,
} from '../lib/copyTradeRules';

/**
 * Copy trade configuration, drawn as the Explore copy screen.
 *
 * Paste wallets, set the defaults once, turn a wallet on or off, and open a
 * wallet only when it should differ. Nothing here watches an address or sends
 * a trade.
 */

type WalletRow = {
  address: string;
  label: string;
  enabled: boolean;
  override: WalletOverride | null;
};

type SetupResponse = {
  wallets?: WalletRow[];
  rules?: CopyTradeRules | null;
};

type SheetState = {
  address: string;
  label: string;
  enabled: boolean;
  form: OverrideForm;
};

type Figures = { amount: string; range: string; sides: string };

const RANGE_DASH = '\u2013';

const FACE_INK: number[][][] = [
  [
    [2, 0], [3, 0], [4, 0],
    [1, 1], [2, 1], [3, 1], [4, 1], [5, 1],
    [1, 2], [3, 2], [5, 2],
    [1, 3], [2, 3], [3, 3], [4, 3], [5, 3],
    [2, 4], [4, 4],
    [1, 5], [2, 5], [3, 5], [4, 5], [5, 5],
    [0, 6], [2, 6], [3, 6], [4, 6], [6, 6],
  ],
  [
    [0, 0], [6, 0],
    [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1],
    [1, 2], [3, 2], [5, 2],
    [1, 3], [2, 3], [3, 3], [4, 3], [5, 3],
    [2, 4], [4, 4],
    [1, 5], [2, 5], [3, 5], [4, 5], [5, 5],
    [3, 6],
  ],
  [
    [2, 0], [3, 0], [4, 0],
    [1, 1], [2, 1], [3, 1], [4, 1], [5, 1],
    [0, 2], [1, 2], [3, 2], [5, 2], [6, 2],
    [0, 3], [1, 3], [2, 3], [3, 3], [4, 3], [5, 3], [6, 3],
    [1, 4], [2, 4], [4, 4], [5, 4],
    [2, 5], [3, 5], [4, 5],
  ],
];

const FACE_COLORS = ['#f3d27a', '#f0e2c4', '#e0a15a', '#c5d6a1'];
const FACE_BACKS = ['#3a2e16', '#2c261c', '#3a2418', '#243024'];

function short(address: string) {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function walletsFrom(setup: SetupResponse): WalletRow[] {
  return (setup.wallets || []).map((wallet) => ({
    address: wallet.address,
    label: wallet.label || '',
    enabled: wallet.enabled !== false,
    override: wallet.override ?? null,
  }));
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const copy = list.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

function dollarText(raw: string): string {
  const trimmed = raw.trim().replace(/^\$/, '');
  return trimmed ? `$${trimmed}` : '$0';
}

function rangeText(min: number, max: number): string {
  if (min > 0 && max > 0) return `${formatCompactUsd(min)} ${RANGE_DASH} ${formatCompactUsd(max)}`;
  if (min > 0) return `${formatCompactUsd(min)} and up`;
  if (max > 0) return `Up to ${formatCompactUsd(max)}`;
  return 'Any';
}

function sidesText(buys: boolean, sells: boolean): string {
  if (buys && sells) return 'Buy + Sell';
  if (buys) return 'Buy only';
  if (sells) return 'Sell only';
  return 'Off';
}

function summaryFrom(rules: CopyTradeRules | null, form: RuleForm) {
  if (rules?.ready) {
    return {
      perTrade: formatUsdFromCents(rules.buyUsdCents),
      range: rangeText(rules.minMcapUsd, rules.maxMcapUsd),
      sides: sidesText(rules.copyBuys, rules.copySells),
      daily: formatUsdFromCents(rules.maxDailyUsdCents),
    };
  }
  return {
    perTrade: dollarText(form.buy),
    range: rangeText(Number(form.minMcap) || 0, Number(form.maxMcap) || 0),
    sides: sidesText(form.copyBuys, form.copySells),
    daily: dollarText(form.maxDaily),
  };
}

function cardFigures(rules: CopyTradeRules | null, form: RuleForm, override: WalletOverride | null): Figures {
  if (rules?.ready) {
    const resolved = resolveWallet(rules, override);
    return {
      amount: formatUsdFromCents(resolved.buyUsdCents),
      range: rangeText(resolved.minMcapUsd, resolved.maxMcapUsd),
      sides: sidesText(resolved.copyBuys, resolved.copySells),
    };
  }
  return {
    amount: override?.buyUsdCents != null ? formatUsdFromCents(override.buyUsdCents) : dollarText(form.buy),
    range: rangeText(
      override?.minMcapUsd != null ? override.minMcapUsd : Number(form.minMcap) || 0,
      override?.maxMcapUsd != null ? override.maxMcapUsd : Number(form.maxMcap) || 0
    ),
    sides: sidesText(override?.copyBuys ?? form.copyBuys, override?.copySells ?? form.copySells),
  };
}

function hashAddress(address: string) {
  let hash = 0;
  for (let i = 0; i < address.length; i += 1) hash = (hash * 33 + address.charCodeAt(i)) >>> 0;
  return hash;
}

function WalletFace({ address }: { address: string }) {
  const hash = hashAddress(address);
  const ink = FACE_INK[hash % FACE_INK.length];
  const color = FACE_COLORS[hash % FACE_COLORS.length];
  const back = FACE_BACKS[hash % FACE_BACKS.length];
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full" style={{ background: back }} aria-hidden>
      <svg width="22" height="22" viewBox="0 0 7 7" shapeRendering="crispEdges">
        {ink.map(([x, y], index) => (
          <rect key={index} x={x} y={y} width="1" height="1" fill={color} />
        ))}
      </svg>
    </span>
  );
}

function GripDots() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden>
      {[0, 1, 2].map((row) =>
        [0, 1].map((col) => <circle key={`${row}-${col}`} cx={2 + col * 6} cy={3 + row * 5} r="1.15" fill="currentColor" />)
      )}
    </svg>
  );
}

function BarsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path fill="currentColor" d="M1 8h2.2v5H1zM5.9 4h2.2v9H5.9zM10.8 1H13v12h-2.2z" />
    </svg>
  );
}

function GoldToggle({
  pressed,
  disabled,
  label,
  compact,
  onClick,
}: {
  pressed: boolean;
  disabled?: boolean;
  label: string;
  compact?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={pressed}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`hit-y-44 relative shrink-0 rounded-full transition-colors ${
        compact ? 'h-[20px] w-[36px]' : 'h-[26px] w-[46px]'
      } ${pressed ? 'bg-[#f7d047]' : 'bg-[#3a3a40]'}`}
    >
      <span
        className={`absolute top-[3px] rounded-full bg-white shadow ${
          compact
            ? `h-3.5 w-3.5 ${pressed ? 'left-[19px]' : 'left-[3px]'}`
            : `h-5 w-5 ${pressed ? 'left-[23px]' : 'left-[3px]'}`
        }`}
      />
    </button>
  );
}

function Feature({ icon, lines }: { icon: ReactNode; lines: [string, string] }) {
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-[10px] border border-[#3d3424] bg-black/35 px-1.5 py-[6px]">
      <span className="shrink-0 text-[#f7d047]">{icon}</span>
      <span className="font-sans text-[9px] leading-[1.15] text-[#ece7df]">
        {lines[0]}
        <span className="block">{lines[1]}</span>
      </span>
    </div>
  );
}

function HeroArt() {
  return (
    <div className="pointer-events-none absolute right-0 top-0 h-[138px] w-[156px]" aria-hidden>
      <svg viewBox="0 0 156 138" width="156" height="138">
        <defs>
          <radialGradient id="copyHeroGlow" cx="68%" cy="28%" r="62%">
            <stop offset="0%" stopColor="#f7d047" stopOpacity="0.42" />
            <stop offset="68%" stopColor="#f7d047" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="copyCoinGold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fff1c2" />
            <stop offset="48%" stopColor="#f7d047" />
            <stop offset="100%" stopColor="#a97822" />
          </linearGradient>
          <linearGradient id="copyCoinBronze" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#6d5a40" />
            <stop offset="100%" stopColor="#1c1610" />
          </linearGradient>
          <linearGradient id="copyCardFace" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#322a1c" />
            <stop offset="100%" stopColor="#100e0b" />
          </linearGradient>
        </defs>
        <ellipse cx="112" cy="46" rx="64" ry="50" fill="url(#copyHeroGlow)" />
        <path d="M96 8c28 10 42 28 46 52" fill="none" stroke="#f7d047" strokeOpacity="0.35" strokeWidth="1.2" />
        <g transform="translate(86 14) rotate(14)">
          <rect width="54" height="64" rx="8" fill="#14110d" stroke="#f7d047" strokeOpacity="0.28" />
          <circle cx="16" cy="18" r="6" fill="none" stroke="#f7d047" strokeOpacity="0.75" />
          <path d="M12 16.5c.6-1.6 1.8-2.4 4-2.4s3.4.8 4 2.4" fill="none" stroke="#f7d047" strokeWidth="1" />
          <rect x="26" y="14" width="18" height="2.4" rx="1.2" fill="#f7d047" fillOpacity="0.85" />
          <rect x="26" y="20" width="12" height="2" rx="1" fill="#fff" fillOpacity="0.2" />
          <path d="M10 42h8l5-8 7 12 5-5 8 7" fill="none" stroke="#f7d047" strokeOpacity="0.8" strokeWidth="1.3" />
        </g>
        <g transform="translate(48 24) rotate(-8)">
          <rect width="62" height="72" rx="9" fill="url(#copyCardFace)" stroke="#f7d047" strokeOpacity="0.62" />
          <circle cx="18" cy="20" r="8" fill="#1a160f" stroke="#f4efe6" strokeOpacity="0.9" />
          <circle cx="18" cy="18" r="2.1" fill="#f4efe6" />
          <path d="M13 24c1 2 2.6 2.8 5 2.8s4-0.8 5-2.8" fill="none" stroke="#f4efe6" strokeWidth="1.1" />
          <rect x="32" y="15" width="22" height="2.6" rx="1.3" fill="#f7d047" />
          <rect x="32" y="21" width="15" height="2" rx="1" fill="#fff" fillOpacity="0.28" />
          <rect x="12" y="40" width="38" height="2" rx="1" fill="#fff" fillOpacity="0.14" />
          <rect x="12" y="46" width="26" height="2" rx="1" fill="#fff" fillOpacity="0.1" />
          <circle cx="16" cy="58" r="4" fill="none" stroke="#f7d047" strokeOpacity="0.7" />
        </g>
        <g>
          <circle cx="132" cy="20" r="15" fill="url(#copyCoinGold)" stroke="#fff6d2" strokeWidth="1.1" />
          <path d="M132 9l5.2 8.2-5.2 3-5.2-3z" fill="#3a2910" />
          <path d="M132 9v11.2l5.2-3z" fill="#5a4018" />
          <path d="M126.8 18.4l5.2 7.6 5.2-7.6-5.2 2.8z" fill="#3a2910" />
        </g>
        <g>
          <circle cx="140" cy="58" r="16" fill="url(#copyCoinBronze)" stroke="#e0b84a" strokeWidth="1.5" />
          <path d="M140 46l-6 9.6 6 3.4 6-3.4z" fill="#e0b84a" />
          <path d="M140 46v13l6-3.4z" fill="#fff1c2" />
          <path d="M134 57.2l6 8 6-8-6 3.2z" fill="#c9a15a" />
        </g>
        <g>
          <circle cx="104" cy="96" r="18" fill="url(#copyCoinGold)" stroke="#fff6d2" strokeWidth="1.2" />
          <text x="104" y="102" textAnchor="middle" fontSize="16" fontWeight="700" fill="#1a1405" fontFamily="ui-sans-serif, sans-serif">
            F
          </text>
        </g>
        <g>
          <circle cx="138" cy="100" r="11" fill="#16130e" stroke="#e0b84a" strokeWidth="1.2" />
          <circle cx="138" cy="96" r="3.1" fill="#f7d047" />
          <path d="M131.5 107c1.3-3.4 3.4-4.8 6.5-4.8s5.2 1.4 6.5 4.8" fill="#f7d047" />
        </g>
      </svg>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden rounded-[18px] border border-[#6a5a32] bg-[#100e0b] px-3.5 pb-3.5 pt-3.5">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_80%_at_88%_18%,rgba(247,208,71,0.2),transparent_58%)]" />
      <div className="relative min-h-[138px]">
        <HeroArt />
        <div className="relative max-w-[200px]">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#f7d047]/45 px-2 py-[3px] font-sans text-[9px] font-semibold tracking-[0.14em] text-[#f7d047]">
            <GiwaMarkIcon size={12} />
            GIWA CHAIN
          </span>
          <h2 className="m-0 mt-2.5 font-sans text-[26px] font-bold leading-[0.98] tracking-tight text-white">
            Copy trade
            <span className="mt-0.5 block text-[#f7d047]">top wallets</span>
          </h2>
          <p className="mb-0 mt-2 font-sans text-[12px] leading-snug text-[#d5d0c8]">
            Automatically mirror trades from wallets you trust with your own settings.
          </p>
        </div>
      </div>
      <div className="relative z-10 mt-3 grid grid-cols-3 gap-1.5">
        <Feature icon={<BoltIcon size={13} />} lines={['Set your', 'amount']} />
        <Feature icon={<BarsIcon />} lines={['Min / Max', 'market cap']} />
        <Feature icon={<ShieldCheckIcon size={13} />} lines={['Full control', 'anytime']} />
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 py-2">
      <span className="font-sans text-[12px] font-medium text-white">{label}</span>
      {hint ? <span className="text-[11px] leading-relaxed text-[#8d867c]">{hint}</span> : null}
      <input
        className="w-full rounded-[10px] border border-[#2a2b30] bg-[#0c0c0e] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#f7d047]"
        inputMode="decimal"
        value={value}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function Choice({
  checked,
  label,
  hint,
  radio,
  onChange,
}: {
  checked: boolean;
  label: string;
  hint?: string;
  radio?: string;
  onChange: () => void;
}) {
  return (
    <label className="flex min-h-11 items-start gap-2 py-1 text-sm text-white">
      <input
        type={radio ? 'radio' : 'checkbox'}
        name={radio}
        className="mt-1 accent-[#e0b84a]"
        checked={checked}
        onChange={onChange}
      />
      <span>
        <span className="block">{label}</span>
        {hint ? <span className="block text-[11px] leading-relaxed text-[#8d867c]">{hint}</span> : null}
      </span>
    </label>
  );
}

function SheetFrame({
  label,
  title,
  detail,
  leading,
  saving,
  onClose,
  children,
}: {
  label: string;
  title: string;
  detail?: ReactNode;
  leading?: ReactNode;
  saving: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/75 sm:items-center sm:p-6"
      role="presentation"
      onClick={() => !saving && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        className="relative max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-[20px] border border-[#3a3424] bg-[#100e0b] px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_24px_80px_rgba(0,0,0,0.55)] sm:rounded-[20px]"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(80%_100%_at_50%_0%,rgba(247,208,71,0.16),transparent)]" />
        <div className="relative mx-auto mb-3 h-1 w-10 rounded-full bg-[#3a3a40] sm:hidden" />
        <div className="relative flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {leading}
            <div className="min-w-0">
              <h2 className="m-0 truncate font-sans text-[16px] font-semibold text-white">{title}</h2>
              {detail ? (
                <div className="m-0 mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[11px] text-[#8d867c]">{detail}</div>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="hit-44 shrink-0 rounded-full border border-[#2a2b30] px-3 py-1 font-sans text-[11px] text-[#b7b1a8]"
            onClick={onClose}
            disabled={saving}
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

export function CopyTradePanel() {
  const [form, setForm] = useState<RuleForm | null>(null);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [rules, setRules] = useState<CopyTradeRules | null>(null);
  const [paste, setPaste] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [rename, setRename] = useState<{ address: string; value: string } | null>(null);
  const [copied, setCopied] = useState('');
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const formSnapshot = useRef<RuleForm | null>(null);
  const drag = useRef<{ from: number; snapshot: WalletRow[]; over: number } | null>(null);
  const renameBusy = useRef(false);
  // State updates too late to stop a second click in the same turn.
  const saveLock = useRef(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/copy?kind=trade');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || 'Could not load this setup.');
        setForm(formFromRules(null));
        setWallets([]);
        setRules(null);
        return;
      }
      const setup = (body.setup || {}) as SetupResponse;
      setWallets(walletsFrom(setup));
      setRules(setup.rules ?? null);
      setForm(formFromRules(setup.rules ?? null));
    } catch {
      setError('Could not load this setup.');
      setForm(formFromRules(null));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function persist(
    next: WalletRow[],
    commit: boolean,
    replaceForm: boolean,
    sheetOverride?: SheetState
  ): Promise<boolean> {
    if (!form || saveLock.current) return false;
    saveLock.current = true;
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/copy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'trade',
          wallets: next.map((wallet) => {
            const editing = sheetOverride && sheetOverride.address === wallet.address ? sheetOverride : null;
            return {
              address: wallet.address,
              enabled: editing ? editing.enabled : wallet.enabled,
              label: editing ? editing.label : wallet.label || null,
              // A toggle resends the saved override. The defaults shown in the
              // sheet are not part of that payload, or an inherited wallet
              // would become a custom one.
              override: editing
                ? overridePayload(editing.form)
                : overridePayload(overrideFormFrom(wallet.override)),
            };
          }),
          rules: { ...form, commit },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || 'Could not save.');
        return false;
      }
      const setup = (body.setup || {}) as SetupResponse;
      setWallets(walletsFrom(setup));
      setRules(setup.rules ?? null);
      if (replaceForm) setForm(formFromRules(setup.rules ?? null));
      return true;
    } catch {
      setError('Could not save.');
      return false;
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }

  async function addFromPaste() {
    if (!form || saving) return;
    const split = splitWalletPaste(paste, wallets.map((wallet) => wallet.address));
    if (split.error) {
      setError(split.error);
      setNote('');
      return;
    }
    if (!split.addresses.length) {
      setError('');
      setNote('Those wallets are already on the list.');
      return;
    }
    const next = [
      ...wallets,
      ...split.addresses.map((address) => ({
        address,
        label: '',
        enabled: true,
        override: null,
      })),
    ];
    const ok = await persist(next, false, false);
    if (!ok) return;
    setPaste('');
    const added = split.addresses.length;
    const skipped =
      split.skipped > 0
        ? ` ${split.skipped} ${split.skipped === 1 ? 'line was' : 'lines were'} not a wallet address.`
        : '';
    setNote(`${added} ${added === 1 ? 'wallet added' : 'wallets added'}.${skipped}`);
  }

  async function updateWallets(next: WalletRow[], message: string) {
    if (saving) return;
    const ok = await persist(next, false, false);
    if (ok) setNote(message);
  }

  function patch(partial: Partial<RuleForm>) {
    setForm((current) => (current ? { ...current, ...partial } : current));
  }

  function openWallet(wallet: WalletRow) {
    if (!form) return;
    setError('');
    setSheet({
      address: wallet.address,
      label: wallet.label,
      enabled: wallet.enabled,
      form: overrideFormFrom(wallet.override, {
        minMcap: form.minMcap,
        maxMcap: form.maxMcap,
        copyBuys: form.copyBuys,
        copySells: form.copySells,
        sellMode: form.sellMode,
        sellAmount: form.sellAmount,
      }),
    });
  }

  function openDefaults() {
    if (!form) return;
    formSnapshot.current = form;
    setError('');
    setDefaultsOpen(true);
  }

  function dismissDefaults() {
    if (formSnapshot.current) setForm(formSnapshot.current);
    formSnapshot.current = null;
    setDefaultsOpen(false);
  }

  async function commitRename() {
    if (renameBusy.current || !rename || !form) return;
    renameBusy.current = true;
    try {
      const current = wallets.find((wallet) => wallet.address === rename.address);
      const name = rename.value.replace(/\s+/g, ' ').trim();
      setRename(null);
      if (!current) return;
      if (!name || [...name].length > 32 || /[\u0000-\u001f\u007f]/.test(rename.value)) {
        setError('A wallet name needs 1 to 32 characters.');
        return;
      }
      if (name === current.label) return;
      const next = wallets.map((wallet) => (wallet.address === rename.address ? { ...wallet, label: name } : wallet));
      const ok = await persist(next, false, false);
      if (ok) setNote('Wallet renamed.');
    } finally {
      renameBusy.current = false;
    }
  }

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(address);
      window.setTimeout(() => setCopied((current) => (current === address ? '' : current)), 1200);
    } catch {
      setError('Could not copy that address.');
    }
  }

  function onGripDown(index: number, event: PointerEvent<HTMLButtonElement>) {
    if (saving) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { from: index, snapshot: wallets, over: index };
  }

  function onGripMove(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (!state) return;
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-wallet-index]');
    if (!hit) return;
    const over = Number(hit.getAttribute('data-wallet-index'));
    if (!Number.isInteger(over) || over === state.over) return;
    state.over = over;
    setWallets(moveItem(state.snapshot, state.from, over));
  }

  async function onGripUp() {
    const state = drag.current;
    drag.current = null;
    if (!state || state.over === state.from) return;
    const next = moveItem(state.snapshot, state.from, state.over);
    const ok = await persist(next, false, false);
    if (!ok) setWallets(state.snapshot);
    else setNote('Order saved.');
  }

  const ready = rules?.ready === true;
  const summary = form ? summaryFrom(rules, form) : null;
  const dialogOpen = Boolean(sheet || defaultsOpen);

  return (
    <div className="grid w-full gap-3">
      <Hero />

      {error && !dialogOpen ? <p className="alert alert-error">{error}</p> : null}
      {!form || !summary ? <p className="m-0 font-sans text-sm text-[#8d867c]">Loading...</p> : null}

      {form && summary ? (
        <section className="rounded-[16px] border border-[#2a2b30] bg-[#101012] px-3.5 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-[#2a2416] text-[#f7d047]">
                <GearIcon size={15} />
              </span>
              <div className="min-w-0">
                <h3 className="m-0 font-sans text-[15px] font-semibold text-white">Default settings</h3>
                <p className="mb-0 mt-0.5 font-sans text-[11px] leading-snug text-[#8d867c]">
                  These settings will be applied to new wallets you add.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={openDefaults}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[9px] border border-[#f7d047] px-2.5 font-sans text-[11px] font-semibold text-[#f7d047]"
            >
              Edit defaults
              <ChevronRightIcon size={12} />
            </button>
          </div>
          <div className="mt-4 grid grid-cols-4 divide-x divide-[#2e2a24]">
            <SummaryStat value={summary.perTrade} label="Per trade" />
            <SummaryStat value={summary.range} label="Market cap range" />
            <SummaryStat value={summary.sides} label="Trade types" />
            <SummaryStat value={summary.daily} label="Daily limit" />
          </div>
          {ready ? null : (
            <p className="mb-0 mt-3 font-sans text-[10px] leading-snug text-[#8d867c]">
              These numbers are suggestions until you start.
            </p>
          )}
          <p className="mb-0 mt-2 font-sans text-[10px] leading-snug text-[#8d867c]">
            Copying does not run yet. This screen spends nothing.
          </p>
        </section>
      ) : null}

      <section className="rounded-[16px] border border-[#2a2b30] bg-[#101012] px-3 py-3.5">
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-[#f7d047] text-[#1a1405]">
            <PlusIcon size={13} strokeWidth={2.4} />
          </span>
          <h3 className="m-0 font-sans text-[15px] font-semibold text-white">Add wallets</h3>
          <button
            type="button"
            className="hit-44 grid h-6 w-6 place-items-center text-[#8d867c]"
            aria-label="How to paste wallets"
            onClick={() => pasteRef.current?.focus()}
          >
            <HelpIcon size={16} />
          </button>
        </div>
        <div className="mt-3 flex items-center gap-1.5">
          <div className="min-w-0 flex-1 [container-type:inline-size]">
            <textarea
              ref={pasteRef}
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={'Paste wallet addresses (separated by space, comma or new line)\n0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6\n0x8F3e2D6f9b8a4a1e0d2C5f8e1A9b7C3d4E5f6A7b'}
              aria-label="Paste wallet addresses"
              style={{ fontSize: 'clamp(8px, calc((100cqi - 16px) / 26), 12px)' }}
              className="box-border min-h-[84px] w-full resize-none rounded-[12px] border border-[#2a2b30] bg-[#0c0c0e] px-2 py-2 font-mono leading-[1.45] text-[#d5d0c8] outline-none placeholder:text-[#8d877e] focus:border-[#f7d047]"
            />
          </div>
          <button
            type="button"
            disabled={saving || !form}
            onClick={addFromPaste}
            className="h-11 shrink-0 rounded-[12px] bg-[#f7d047] px-2.5 font-sans text-[13px] font-bold text-[#1a1405] disabled:opacity-45"
          >
            Add wallets
          </button>
        </div>
        <p className="mb-0 mt-2.5 flex items-start gap-1.5 font-sans text-[11px] leading-snug text-[#b7b1a8]">
          <InfoIcon size={14} className="mt-px shrink-0 text-[#f7d047]" />
          You can paste one or multiple wallet addresses at once.
        </p>
        {note ? <p className="mb-0 mt-2 font-sans text-[12px] text-[#f7d047]">{note}</p> : null}
      </section>

      <section>
        <div className="flex items-center justify-between gap-2">
          <h3 className="m-0 font-sans text-[16px] font-bold text-white">Copied wallets ({wallets.length})</h3>
          {wallets.length > 0 ? (
            <button
              type="button"
              disabled={saving || !form}
              onClick={() => {
                const cleared = wallets.map((wallet) => ({ ...wallet, override: null }));
                persist(cleared, true, true).then((ok) => {
                  if (ok) setNote('Defaults now apply to every wallet.');
                });
              }}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[9px] border border-[#3a3424] px-2 font-sans text-[10px] font-semibold text-[#f7d047] disabled:opacity-45"
            >
              <SwapArrowsIcon size={12} />
              Apply defaults to all
              <ChevronRightIcon size={12} />
            </button>
          ) : null}
        </div>
        {wallets.length === 0 ? <p className="mb-0 mt-3 font-sans text-[12px] text-[#8d867c]">No wallets yet.</p> : null}
        {wallets.length > 0 ? (
          <ul className="m-0 mt-2.5 list-none space-y-2.5 p-0">
            {wallets.map((wallet, index) => {
              const figures = form ? cardFigures(rules, form, wallet.override) : null;
              const name = wallet.label || 'Wallet';
              return (
                <li
                  key={wallet.address}
                  data-wallet-index={index}
                  className="rounded-[16px] border border-[#2a2b30] bg-[#101012] px-2.5 py-3"
                >
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      className="hit-y-44 touch-none grid h-9 w-4 shrink-0 place-items-center text-[#6f6a64]"
                      aria-label={`Reorder ${name}`}
                      disabled={saving}
                      onPointerDown={(event) => onGripDown(index, event)}
                      onPointerMove={onGripMove}
                      onPointerUp={onGripUp}
                      onPointerCancel={onGripUp}
                    >
                      <GripDots />
                    </button>
                    <WalletFace address={wallet.address} />
                    <div className="min-w-0 flex-1">
                      {rename?.address === wallet.address ? (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            commitRename();
                          }}
                        >
                          <input
                            autoFocus
                            value={rename.value}
                            maxLength={32}
                            aria-label={`Name for ${short(wallet.address)}`}
                            className="w-full rounded border border-[#f7d047]/60 bg-transparent px-1 py-0.5 font-sans text-[13px] font-semibold text-white outline-none"
                            onChange={(event) => setRename({ address: wallet.address, value: event.target.value })}
                            onBlur={commitRename}
                          />
                        </form>
                      ) : (
                        <div className="flex min-w-0 items-center gap-1">
                          <button
                            type="button"
                            className="truncate text-left font-sans text-[13px] font-semibold text-white"
                            onClick={() => openWallet(wallet)}
                          >
                            {name}
                          </button>
                          <button
                            type="button"
                            className="hit-44 grid h-5 w-5 shrink-0 place-items-center text-[#f7d047]"
                            aria-label={`Rename ${name}`}
                            onClick={() => setRename({ address: wallet.address, value: wallet.label })}
                          >
                            <PencilIcon size={12} />
                          </button>
                        </div>
                      )}
                      <div className="mt-0.5 flex items-center gap-1">
                        <span className="truncate font-mono text-[10px] text-[#8d867c]">{short(wallet.address)}</span>
                        <button
                          type="button"
                          className="hit-44 grid h-5 w-5 shrink-0 place-items-center text-[#8d867c]"
                          aria-label={`Copy ${short(wallet.address)}`}
                          onClick={() => copyAddress(wallet.address)}
                        >
                          <CopyIcon size={12} />
                        </button>
                        {copied === wallet.address ? <span className="font-sans text-[10px] text-[#f7d047]">Copied</span> : null}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-[3px] font-sans text-[10px] font-semibold ${
                        wallet.enabled ? 'bg-[#163d28] text-[#6ee7a8]' : 'bg-[#2a2b30] text-[#b5b5b8]'
                      }`}
                    >
                      {wallet.enabled ? 'Active' : 'Paused'}
                    </span>
                    <GoldToggle
                      compact
                      pressed={wallet.enabled}
                      disabled={saving}
                      label={`${name} ${wallet.enabled ? 'on' : 'off'}`}
                      onClick={() =>
                        updateWallets(
                          wallets.map((row) =>
                            row.address === wallet.address ? { ...row, enabled: !row.enabled } : row
                          ),
                          wallet.enabled ? 'Paused.' : 'On.'
                        )
                      }
                    />
                    <button
                      type="button"
                      className="hit-44 grid h-7 w-5 shrink-0 place-items-center text-[#8d867c]"
                      aria-label={`Settings for ${name}`}
                      onClick={() => openWallet(wallet)}
                    >
                      <ChevronRightIcon size={16} />
                    </button>
                  </div>
                  {figures ? (
                    <div className="mt-3 grid grid-cols-3 gap-1.5 pl-5">
                      <MiniStat icon={<TokensIcon size={14} />} value={figures.amount} label="Per trade" />
                      <MiniStat icon={<BarsIcon />} value={figures.range} label="Market cap range" />
                      <MiniStat icon={<SwapArrowsIcon size={14} />} value={figures.sides} label="Trade types" />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {defaultsOpen && form ? (
        <DefaultsSheet
          form={form}
          ready={ready}
          saving={saving}
          advanced={advanced}
          error={error}
          onPatch={patch}
          onAdvanced={() => setAdvanced((open) => !open)}
          onClose={dismissDefaults}
          onSave={() => {
            const wasReady = ready;
            persist(wallets, true, true).then((ok) => {
              if (!ok) return;
              formSnapshot.current = null;
              setDefaultsOpen(false);
              setNote(wasReady ? 'Defaults saved.' : 'Copy trading is saved. It still does not run.');
            });
          }}
        />
      ) : null}

      {sheet && form ? (
        <WalletSheet
          sheet={sheet}
          inheritedBuy={form.buy}
          saving={saving}
          error={error}
          onChange={setSheet}
          onClose={() => setSheet(null)}
          onSave={async () => {
            const name = sheet.label.replace(/\s+/g, ' ').trim();
            if (!name || [...name].length > 32 || /[\u0000-\u001f\u007f]/.test(sheet.label)) {
              setError('A wallet name needs 1 to 32 characters.');
              return;
            }
            const next = wallets.map((wallet) =>
              wallet.address === sheet.address ? { ...wallet, label: name, enabled: sheet.enabled } : wallet
            );
            const ok = await persist(next, false, false, { ...sheet, label: name });
            if (ok) {
              setSheet(null);
              setNote('Wallet saved.');
            }
          }}
          onRemove={async () => {
            const next = wallets.filter((wallet) => wallet.address !== sheet.address);
            const ok = await persist(next, false, false);
            if (ok) {
              setSheet(null);
              setNote('Wallet removed.');
            }
          }}
        />
      ) : null}
    </div>
  );
}

function SummaryStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0 px-1.5 first:pl-0 last:pr-0">
      <div className="whitespace-nowrap font-sans text-[12px] font-bold leading-tight text-white">{value}</div>
      <div className="mt-1 font-sans text-[9px] leading-tight text-[#8d867c]">{label}</div>
    </div>
  );
}

function MiniStat({ icon, value, label }: { icon: ReactNode; value: string; label: string }) {
  return (
    <div className="flex min-w-0 items-start gap-1">
      <span className="mt-0.5 shrink-0 text-[#f7d047]">{icon}</span>
      <span className="min-w-0">
        <span className="block whitespace-nowrap font-sans text-[11px] font-semibold leading-tight text-white">{value}</span>
        <span className="mt-0.5 block font-sans text-[9px] leading-tight text-[#8d867c]">{label}</span>
      </span>
    </div>
  );
}

function DefaultsSheet({
  form,
  ready,
  saving,
  advanced,
  error,
  onPatch,
  onAdvanced,
  onClose,
  onSave,
}: {
  form: RuleForm;
  ready: boolean;
  saving: boolean;
  advanced: boolean;
  error: string;
  onPatch: (partial: Partial<RuleForm>) => void;
  onAdvanced: () => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <SheetFrame label="Default settings" title="Default settings" saving={saving} onClose={onClose}>
      <p className="mb-0 mt-2 font-sans text-[12px] leading-relaxed text-[#8d867c]">
        New wallets use these. Change one wallet only when it should differ.
      </p>
      <Field
        label="Amount per trade"
        hint="If a followed wallet buys, Flizy buys this much of the same token."
        value={form.buy}
        onChange={(value) => onPatch({ buy: value })}
      />
      <Field
        label="Minimum market cap"
        hint="Skip a trade below this. Empty means no minimum."
        value={form.minMcap}
        onChange={(value) => onPatch({ minMcap: value })}
      />
      <Field
        label="Maximum market cap"
        hint="Skip a trade above this. Empty means no maximum."
        value={form.maxMcap}
        onChange={(value) => onPatch({ maxMcap: value })}
      />
      <div className="mt-2 flex items-center justify-between gap-3 py-1">
        <span className="font-sans text-[13px] text-white">Copy buys</span>
        <GoldToggle pressed={form.copyBuys} disabled={saving} label="Copy buys" onClick={() => onPatch({ copyBuys: !form.copyBuys })} />
      </div>
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="font-sans text-[13px] text-white">Copy sells</span>
        <GoldToggle
          pressed={form.copySells}
          disabled={saving}
          label="Copy sells"
          onClick={() => onPatch({ copySells: !form.copySells })}
        />
      </div>
      <div className="py-2">
        <p className="m-0 font-sans text-[13px] font-medium text-white">How to sell</p>
        <Choice
          radio="default-sell"
          checked={form.sellMode === 'percent'}
          label="Sell same percentage"
          hint="If they sell half of their position, Flizy sells half of yours."
          onChange={() => onPatch({ sellMode: 'percent' })}
        />
        <Choice
          radio="default-sell"
          checked={form.sellMode === 'fixed'}
          label="Fixed sell amount"
          onChange={() => onPatch({ sellMode: 'fixed' })}
        />
        {form.sellMode === 'fixed' ? (
          <Field label="Sell amount" value={form.sellAmount} onChange={(value) => onPatch({ sellAmount: value })} />
        ) : null}
      </div>
      <h3 className="mb-0 mt-3 font-sans text-[15px] font-semibold text-white">Safety limits</h3>
      <p className="mb-0 mt-1 font-sans text-[11px] leading-relaxed text-[#8d867c]">
        A wallet that trades all day cannot spend more than the daily limit.
      </p>
      <Field label="Maximum per trade" value={form.maxPerTrade} onChange={(value) => onPatch({ maxPerTrade: value })} />
      <Field label="Maximum daily spend" value={form.maxDaily} onChange={(value) => onPatch({ maxDaily: value })} />
      <Field
        label="Maximum open positions"
        value={form.maxOpenPositions}
        onChange={(value) => onPatch({ maxOpenPositions: value })}
      />
      <button
        type="button"
        className="mt-3 min-h-11 text-left font-sans text-[12px] text-[#8d867c]"
        aria-expanded={advanced}
        onClick={onAdvanced}
      >
        {advanced ? 'Hide advanced settings' : 'Advanced settings'}
      </button>
      {advanced ? (
        <div className="border-t border-[#2a2b30] pt-2">
          <Choice
            checked={form.ignoreStablecoins}
            label="Ignore stablecoins"
            onChange={() => onPatch({ ignoreStablecoins: !form.ignoreStablecoins })}
          />
          <Choice
            checked={form.firstBuyOnly}
            label="Only copy the first buy"
            onChange={() => onPatch({ firstBuyOnly: !form.firstBuyOnly })}
          />
          <Choice
            checked={form.skipLiquidity}
            label="Skip liquidity adds and removes"
            onChange={() => onPatch({ skipLiquidity: !form.skipLiquidity })}
          />
          <Choice checked={form.skipTransfers} label="Skip transfers" onChange={() => onPatch({ skipTransfers: !form.skipTransfers })} />
          <Choice checked={form.skipFailed} label="Skip failed trades" onChange={() => onPatch({ skipFailed: !form.skipFailed })} />
          <Field label="Slippage (%)" value={form.slippagePct} onChange={(value) => onPatch({ slippagePct: value })} />
          <Field
            label="Max gas (gwei)"
            hint="Empty means no gas cap."
            value={form.maxGasGwei}
            onChange={(value) => onPatch({ maxGasGwei: value })}
          />
          <Field label="Cooldown (seconds)" value={form.cooldownSec} onChange={(value) => onPatch({ cooldownSec: value })} />
          <Field
            label="Minimum token age (minutes)"
            value={form.minTokenAgeMin}
            onChange={(value) => onPatch({ minTokenAgeMin: value })}
          />
          <Field
            label="Minimum liquidity"
            hint="Empty means no liquidity floor."
            value={form.minLiquidity}
            onChange={(value) => onPatch({ minLiquidity: value })}
          />
          <Field
            label="Daily cap for one wallet"
            hint="0 means no cap on how many trades one wallet can cause."
            value={form.walletDailyCap}
            onChange={(value) => onPatch({ walletDailyCap: value })}
          />
        </div>
      ) : null}
      {error ? <p className="alert alert-error mt-3">{error}</p> : null}
      <button
        type="button"
        className="mt-4 w-full rounded-[12px] bg-[#f7d047] py-3 font-sans text-[14px] font-bold text-[#1a1405] disabled:opacity-45"
        disabled={saving}
        onClick={onSave}
      >
        {saving ? 'Saving...' : ready ? 'Save defaults' : 'Start Copy Trading'}
      </button>
      <p className="mb-0 mt-3 font-sans text-[11px] leading-relaxed text-[#8d867c]">This does not send a trade.</p>
    </SheetFrame>
  );
}

function SheetBlock({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="mt-3 rounded-[14px] border border-[#2a2b30] bg-[#0c0c0e] px-3 py-3">
      <h3 className="m-0 font-sans text-[13px] font-semibold text-white">{title}</h3>
      <p className="mb-0 mt-1 font-sans text-[11px] leading-relaxed text-[#8d867c]">{hint}</p>
      {children}
    </section>
  );
}

function Segment({
  useDefault,
  defaultLabel,
  customLabel,
  disabled,
  onPick,
}: {
  useDefault: boolean;
  defaultLabel: string;
  customLabel: string;
  disabled?: boolean;
  onPick: (useDefault: boolean) => void;
}) {
  const tab = (selected: boolean, label: string, next: boolean) => (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => onPick(next)}
      className={`min-h-9 rounded-[8px] px-2 py-1.5 font-sans text-[11px] font-semibold leading-tight ${
        selected ? 'bg-[#f7d047] text-[#1a1405]' : 'text-[#b7b1a8]'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="mt-2.5 grid grid-cols-2 gap-1 rounded-[10px] bg-[#16140f] p-1">
      {tab(useDefault, defaultLabel, true)}
      {tab(!useDefault, customLabel, false)}
    </div>
  );
}

function figureText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Any';
  const amount = Number(trimmed);
  if (!Number.isFinite(amount)) return trimmed;
  return amount >= 1000 ? formatCompactUsd(amount) : `$${trimmed}`;
}

function WalletSheet({
  sheet,
  inheritedBuy,
  saving,
  error,
  onChange,
  onClose,
  onSave,
  onRemove,
}: {
  sheet: SheetState;
  inheritedBuy: string;
  saving: boolean;
  error: string;
  onChange: (next: SheetState) => void;
  onClose: () => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  const form = sheet.form;
  const [copied, setCopied] = useState(false);
  function patch(partial: Partial<OverrideForm>) {
    onChange({ ...sheet, form: { ...form, ...partial } });
  }

  return (
    <SheetFrame
      label={sheet.label || 'Wallet settings'}
      title={sheet.label || 'Wallet'}
      detail={
        <>
          <span className="truncate">{short(sheet.address)}</span>
          <button
            type="button"
            className="shrink-0 font-sans text-[11px] text-[#f7d047]"
            onClick={() => {
              navigator.clipboard.writeText(sheet.address).then(
                () => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                },
                () => undefined
              );
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </>
      }
      leading={<WalletFace address={sheet.address} />}
      saving={saving}
      onClose={onClose}
    >
      <label className="relative mt-4 grid gap-1">
        <span className="font-sans text-[12px] font-medium text-white">Name</span>
        <input
          className="w-full rounded-[12px] border border-[#2a2b30] bg-[#0c0c0e] px-3 py-2.5 font-sans text-sm text-white outline-none focus:border-[#f7d047]"
          value={sheet.label}
          maxLength={32}
          autoComplete="off"
          aria-label="Wallet name"
          onChange={(event) => onChange({ ...sheet, label: event.target.value })}
        />
      </label>
      <div
        className={`mt-3 flex items-center justify-between gap-3 rounded-[14px] border px-3 py-3 ${
          sheet.enabled ? 'border-[#6a5a32] bg-[#16130c]' : 'border-[#2a2b30] bg-[#0c0c0e]'
        }`}
      >
        <div className="min-w-0">
          <p className="m-0 font-sans text-[13px] font-semibold text-white">Copy trading</p>
          <p className="mb-0 mt-0.5 font-sans text-[11px] text-[#8d867c]">
            {sheet.enabled ? 'On for this wallet.' : 'Paused for this wallet.'}
          </p>
        </div>
        <GoldToggle
          pressed={sheet.enabled}
          disabled={saving}
          label="Copy trading"
          onClick={() => onChange({ ...sheet, enabled: !sheet.enabled })}
        />
      </div>
      <SheetBlock title="Trade amount" hint="How much Flizy uses for each copied buy.">
        <Segment
          useDefault={form.useBuy}
          defaultLabel="Use default"
          customLabel="Custom"
          disabled={saving}
          onPick={(useBuy) => patch({ useBuy })}
        />
        <p className="mb-0 mt-2 font-sans text-[12px] text-[#d5d0c8]">
          {form.useBuy ? `Using ${figureText(inheritedBuy)}` : form.buy.trim() ? figureText(form.buy) : 'Enter an amount.'}
        </p>
        {form.useBuy ? null : <Field label="Custom amount" value={form.buy} onChange={(value) => patch({ buy: value })} />}
      </SheetBlock>
      <SheetBlock title="Market cap" hint="Only copy a trade inside this range.">
        <Segment
          useDefault={form.useMcap}
          defaultLabel="Use default range"
          customLabel="Custom"
          disabled={saving}
          onPick={(useMcap) => patch({ useMcap })}
        />
        <p className="mb-0 mt-2 font-sans text-[12px] text-[#d5d0c8]">
          {form.useMcap ? `${figureText(form.minMcap)} ${RANGE_DASH} ${figureText(form.maxMcap)}` : 'This wallet only.'}
        </p>
        {form.useMcap ? null : (
          <>
            <Field
              label="Minimum"
              hint="Empty means no minimum for this wallet."
              value={form.minMcap}
              onChange={(value) => patch({ minMcap: value })}
            />
            <Field
              label="Maximum"
              hint="Empty means no maximum for this wallet."
              value={form.maxMcap}
              onChange={(value) => patch({ maxMcap: value })}
            />
          </>
        )}
      </SheetBlock>
      <SheetBlock title="What to copy" hint="Buys, sells, or both.">
        <Segment
          useDefault={form.useSides}
          defaultLabel="Use default buy and sell"
          customLabel="Custom"
          disabled={saving}
          onPick={(useSides) => patch({ useSides })}
        />
        <p className="mb-0 mt-2 font-sans text-[12px] text-[#d5d0c8]">
          {form.useSides ? sidesText(form.copyBuys, form.copySells) : 'This wallet only.'}
        </p>
        {form.useSides ? null : (
          <>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="font-sans text-[13px] text-white">Buy</span>
              <GoldToggle compact pressed={form.copyBuys} disabled={saving} label="Buy" onClick={() => patch({ copyBuys: !form.copyBuys })} />
            </div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="font-sans text-[13px] text-white">Sell</span>
              <GoldToggle
                compact
                pressed={form.copySells}
                disabled={saving}
                label="Sell"
                onClick={() => patch({ copySells: !form.copySells })}
              />
            </div>
          </>
        )}
      </SheetBlock>
      <SheetBlock title="How to sell" hint="Match their percentage, or sell a fixed amount.">
        <Segment
          useDefault={form.useSell}
          defaultLabel="Use default sell rule"
          customLabel="Custom"
          disabled={saving}
          onPick={(useSell) => patch({ useSell })}
        />
        {form.useSell ? (
          <p className="mb-0 mt-2 font-sans text-[12px] text-[#d5d0c8]">
            {form.sellMode === 'fixed' ? 'Fixed sell amount' : 'Sell same percentage'}
          </p>
        ) : (
          <>
            <button
              type="button"
              aria-pressed={form.sellMode === 'percent'}
              disabled={saving}
              onClick={() => patch({ sellMode: 'percent' })}
              className={`mt-2.5 w-full rounded-[12px] border px-3 py-2.5 text-left ${
                form.sellMode === 'percent' ? 'border-[#f7d047] bg-[#1a160f]' : 'border-[#2a2b30]'
              }`}
            >
              <span className="block font-sans text-[13px] font-semibold text-white">Sell same percentage</span>
              <span className="mt-0.5 block font-sans text-[11px] leading-snug text-[#8d867c]">
                If they sell half, Flizy sells half of yours.
              </span>
            </button>
            <button
              type="button"
              aria-pressed={form.sellMode === 'fixed'}
              disabled={saving}
              onClick={() => patch({ sellMode: 'fixed' })}
              className={`mt-2 w-full rounded-[12px] border px-3 py-2.5 text-left ${
                form.sellMode === 'fixed' ? 'border-[#f7d047] bg-[#1a160f]' : 'border-[#2a2b30]'
              }`}
            >
              <span className="block font-sans text-[13px] font-semibold text-white">Fixed sell amount</span>
            </button>
            {form.sellMode === 'fixed' ? (
              <Field label="Sell amount" value={form.sellAmount} onChange={(value) => patch({ sellAmount: value })} />
            ) : null}
          </>
        )}
      </SheetBlock>
      {error ? <p className="alert alert-error mt-3">{error}</p> : null}
      <button
        type="button"
        className="relative mt-4 w-full rounded-[12px] bg-[#f7d047] py-3 font-sans text-[14px] font-bold text-[#1a1405] disabled:opacity-45"
        disabled={saving}
        onClick={onSave}
      >
        {saving ? 'Saving...' : 'Save wallet'}
      </button>
      <button
        type="button"
        className="mt-1 w-full py-2 font-sans text-[12px] text-[#a89880] disabled:opacity-45"
        disabled={saving}
        onClick={onRemove}
      >
        Remove wallet
      </button>
      <p className="mb-0 mt-1 text-center font-sans text-[11px] leading-relaxed text-[#8d867c]">This does not send a trade.</p>
    </SheetFrame>
  );
}
