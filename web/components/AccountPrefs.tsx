'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CheckIcon, ChevronDownIcon, SearchIcon } from './ExploreIcons';
import { LOCALES, LOCALE_LABELS, type LocaleCode } from '../lib/locale';
import { SITE_PHONE_COUNTRIES, countryByIso, countryFlag } from '../lib/phoneFormat';

/**
 * Account preference slides: Language and Country, and the hero card that
 * Pay me shares. Gold light from the top right, art kept to the right edge so
 * the copy never sits on its bright part.
 */

export const PREF_CARD =
  'relative overflow-hidden rounded-[18px] border border-[#2e2818] bg-[#0b0b0b] shadow-[0_0_0_1px_rgba(247,208,71,0.04),0_24px_60px_-30px_rgba(247,208,71,0.25)]';
const HERO_BG =
  'radial-gradient(120% 120% at 100% 0%, rgba(70, 50, 16, 0.75) 0%, rgba(40, 30, 12, 0.4) 38%, rgba(11, 11, 11, 0) 72%)';

export function PrefHero({
  eyebrow,
  title,
  accent,
  text,
  art,
  corner,
}: {
  eyebrow: string;
  title: string;
  /** The gold word after the title, if any. */
  accent?: string;
  text: string;
  art?: ReactNode;
  /** Small mark in the top right, over the art. */
  corner?: ReactNode;
}) {
  return (
    <div className="relative min-h-[178px] px-5 pb-5 pt-6" style={{ background: HERO_BG }}>
      {art}
      {corner}
      <div className="relative max-w-[min(62%,420px)]">
        <p className="m-0 font-mono text-[10.5px] font-medium uppercase tracking-[0.24em] text-sun">{eyebrow}</p>
        <h2 className="m-0 mt-2 font-sans text-[30px] font-bold leading-[1.1] tracking-[0.01em] text-white">
          {title}
          {accent ? <span className="text-sun"> {accent}</span> : null}
        </h2>
        <p className="m-0 mt-3 font-sans text-[13.5px] leading-[1.55] text-[#b7b1a8]">{text}</p>
      </div>
    </div>
  );
}

/** Hero art on the right edge, faded into the card on its left side. */
export function HeroArt({ src }: { src: string }) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      className="pointer-events-none absolute right-0 top-0 h-[178px] w-auto select-none opacity-90 [mask-image:linear-gradient(90deg,transparent,#000_38%)] max-[380px]:right-[-36px] max-[380px]:opacity-70"
    />
  );
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

let flagSupport: boolean | null = null;

/**
 * Whether this system draws flag emoji in colour. Windows draws the two
 * letters instead, so there the tile shows the country code on its own.
 */
function emojiFlagsWork(): boolean {
  if (flagSupport != null) return flagSupport;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return (flagSupport = false);
    ctx.textBaseline = 'top';
    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#000';
    ctx.fillText(countryFlag('NG'), 0, 0);
    const pixels = ctx.getImageData(0, 0, 24, 24).data;
    let colour = false;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 0 && (pixels[i] !== pixels[i + 1] || pixels[i + 1] !== pixels[i + 2])) {
        colour = true;
        break;
      }
    }
    flagSupport = colour;
  } catch {
    flagSupport = false;
  }
  return flagSupport;
}

function useEmojiFlags(): boolean {
  // False on the server and the first paint, so both render the same tile.
  const [ok, setOk] = useState(false);
  useEffect(() => setOk(emojiFlagsWork()), []);
  return ok;
}

export function FlagTile({ iso, size = 'md' }: { iso: string; size?: 'sm' | 'md' }) {
  const emoji = useEmojiFlags();
  const box = size === 'sm' ? 'h-[22px] w-[30px] text-[18px]' : 'h-[30px] w-[42px] text-[26px]';
  if (emoji) {
    return (
      <span aria-hidden className={`flex shrink-0 items-center justify-center overflow-hidden rounded-[6px] leading-none ${box}`}>
        {countryFlag(iso)}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-[6px] border border-[#3a3017] bg-[#17140b] font-mono font-semibold tracking-[0.06em] text-sun ${
        size === 'sm' ? 'h-[22px] w-[30px] text-[9.5px]' : 'h-[30px] w-[42px] text-[11px]'
      }`}
    >
      {iso}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

/** The flag each interface language is shown with, and its name in English. */
const LANGUAGE_FACE: Record<LocaleCode, { iso: string; english: string }> = {
  en: { iso: 'GB', english: 'English' },
  ko: { iso: 'KR', english: 'Korean' },
  zh: { iso: 'CN', english: 'Chinese' },
};

export function LanguagePanel({
  eyebrow,
  title,
  text,
  saved,
  value,
  onChange,
  onSave,
  saving,
  saveLabel,
  savingLabel,
  currentLabel,
}: {
  eyebrow: string;
  title: string;
  text: string;
  /** The language the account uses now. */
  saved: LocaleCode;
  value: LocaleCode;
  onChange: (code: LocaleCode) => void;
  onSave: () => void;
  saving: boolean;
  saveLabel: string;
  savingLabel: string;
  currentLabel: string;
}) {
  const groupId = useId();
  return (
    <section className={PREF_CARD}>
      <PrefHero eyebrow={eyebrow} title={title} text={text} art={<HeroArt src="/account/language-globe.webp" />} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
        className="grid gap-2.5 px-4 pb-5 pt-1"
      >
        <div role="radiogroup" aria-labelledby={`${groupId}-label`} className="grid gap-2.5">
          <span id={`${groupId}-label`} className="sr-only">
            {title}
          </span>
          {LOCALES.map((code) => {
            const on = value === code;
            const face = LANGUAGE_FACE[code];
            return (
              <button
                key={code}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange(code)}
                className={`flex min-h-[64px] w-full items-center gap-4 rounded-[14px] border px-4 py-3 text-left transition-colors ${
                  on
                    ? 'border-sun/80 bg-[linear-gradient(90deg,rgba(247,208,71,0.12),rgba(247,208,71,0.03))] shadow-[0_0_24px_-8px_rgba(247,208,71,0.45)]'
                    : 'border-[#26262a] bg-[#0f0f10] hover:border-[#3a3a3e]'
                }`}
              >
                <FlagTile iso={face.iso} />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate font-sans text-[15px] font-semibold text-white" lang={code}>
                    {LOCALE_LABELS[code]}
                  </span>
                  <span className="truncate font-sans text-[12.5px] text-[#9a958c]">
                    {face.english}
                    {saved === code ? <span className="text-sun"> · {currentLabel}</span> : null}
                  </span>
                </span>
                <span
                  aria-hidden
                  className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2 ${
                    on ? 'border-sun' : 'border-[#4a4a50]'
                  }`}
                >
                  {on ? <span className="h-[10px] w-[10px] rounded-full bg-sun" /> : null}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="submit"
          disabled={saving || value === saved}
          className="btn-sun mt-2 h-[50px] w-full rounded-[12px] font-sans text-[15px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? savingLabel : saveLabel}
        </button>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Country
// ---------------------------------------------------------------------------

type CountryChoice = { iso: string; name: string; dial: string };

function matches(country: CountryChoice, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^\+/, '');
  if (!q) return true;
  return country.name.toLowerCase().includes(q) || country.iso.toLowerCase() === q || country.dial.startsWith(q);
}

export function CountryPanel({
  value,
  saved,
  onChange,
  onSave,
  saving,
}: {
  /** ISO code picked on screen, '' for none. */
  value: string;
  /** ISO code saved on the account, '' for none. */
  saved: string;
  onChange: (iso: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const search = useRef<HTMLInputElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);

  const picked = value ? countryByIso(value) : null;
  // "No default" first, then every country the query matches.
  const options = useMemo<Array<CountryChoice | null>>(
    () => [...(query.trim() ? [] : [null]), ...SITE_PHONE_COUNTRIES.filter((c) => matches(c, query))],
    [query]
  );

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const i = options.findIndex((o) => (o?.iso ?? '') === value);
    setActive(i >= 0 ? i : 0);
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // Only on opening: typing moves the highlight itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, listId]);

  function choose(option: CountryChoice | null) {
    onChange(option?.iso ?? '');
    setOpen(false);
    setQuery('');
    trigger.current?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (options.length) choose(options[Math.min(active, options.length - 1)]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
  }

  return (
    <section className={PREF_CARD}>
      <PrefHero
        eyebrow="Country"
        title="Your"
        accent="country"
        text="Pick one country. Chat will add its code when you type a local number. Skip it and chat will ask. You can change it anytime."
        art={<HeroArt src="/account/country-globe.webp" />}
      />
      <div className="h-px bg-[linear-gradient(90deg,transparent,rgba(247,208,71,0.28),transparent)]" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
        className="grid gap-4 px-4 pb-5 pt-5"
      >
        <div ref={wrap} className="relative grid gap-2">
          <span id={`${listId}-label`} className="font-mono text-[10.5px] font-medium uppercase tracking-[0.22em] text-[#b7b1a8]">
            Country
          </span>
          <button
            ref={trigger}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-labelledby={`${listId}-label ${listId}-value`}
            onClick={() => setOpen((o) => !o)}
            className={`flex min-h-[56px] w-full items-center gap-3.5 rounded-[12px] border bg-[#0d0d0e] px-4 text-left transition-colors ${
              open ? 'border-sun' : 'border-[#5a4a1f] hover:border-sun/70'
            }`}
          >
            {picked ? <FlagTile iso={picked.iso} /> : <span className="h-[30px] w-[42px] shrink-0 rounded-[6px] border border-dashed border-[#3a3a3e]" aria-hidden />}
            <span id={`${listId}-value`} className="min-w-0 flex-1 truncate font-sans text-[16px] text-white">
              {picked ? (
                <>
                  {picked.name} <span className="text-[#b7b1a8]">(+{picked.dial})</span>
                </>
              ) : value ? (
                `Saved country ${value}`
              ) : (
                <span className="text-[#9a958c]">No default country</span>
              )}
            </span>
            <ChevronDownIcon size={18} className={`shrink-0 text-[#d9d4ca] transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>

          {open ? (
            <div className="absolute inset-x-0 top-[calc(100%+6px)] z-40 overflow-hidden rounded-[14px] border border-[#3a3017] bg-[#111110] shadow-[0_24px_60px_rgba(0,0,0,0.6)]">
              <label className="flex h-[48px] items-center gap-2.5 border-b border-[#26262a] px-3.5">
                <SearchIcon size={16} className="shrink-0 text-[#9a958c]" />
                <input
                  ref={search}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onKey}
                  role="combobox"
                  aria-expanded
                  aria-controls={listId}
                  aria-activedescendant={options.length ? `${listId}-opt-${active}` : undefined}
                  aria-label="Search countries or codes"
                  placeholder="Search country or +code"
                  autoComplete="off"
                  className="min-w-0 flex-1 bg-transparent font-sans text-[14px] text-white outline-none placeholder:text-[#77736b]"
                />
              </label>
              <ul id={listId} role="listbox" aria-label="Countries" className="m-0 max-h-[300px] list-none overflow-y-auto p-1.5">
                {options.length === 0 ? (
                  <li className="px-3 py-4 font-sans text-[13px] text-[#9a958c]">No country matches that.</li>
                ) : (
                  options.map((option, i) => {
                    const iso = option?.iso ?? '';
                    const selected = iso === value;
                    return (
                      <li
                        key={iso || 'none'}
                        id={`${listId}-opt-${i}`}
                        role="option"
                        aria-selected={selected}
                        onMouseEnter={() => setActive(i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => choose(option)}
                        className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-[10px] px-2.5 ${i === active ? 'bg-[#1d1a10]' : ''}`}
                      >
                        {option ? (
                          <FlagTile iso={option.iso} size="sm" />
                        ) : (
                          <span className="h-[22px] w-[30px] shrink-0 rounded-[6px] border border-dashed border-[#3a3a3e]" aria-hidden />
                        )}
                        <span className="min-w-0 flex-1 truncate font-sans text-[14px] text-white">{option ? option.name : 'No default country'}</span>
                        {option ? <span className="shrink-0 font-mono text-[12px] text-[#9a958c]">+{option.dial}</span> : null}
                        {selected ? <CheckIcon size={14} strokeWidth={3} className="shrink-0 text-sun" /> : <span className="w-[14px] shrink-0" />}
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="flex gap-3.5 rounded-[14px] border border-[#26262a] bg-[#0f0f10] p-4">
          <span className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full bg-[#1d1a10] text-sun">
            <PhoneGlyph />
          </span>
          <div className="grid gap-1.5">
            <p className="m-0 font-mono text-[10.5px] font-medium uppercase tracking-[0.22em] text-[#9a958c]">Example</p>
            <p className="m-0 font-sans text-[13px] leading-[1.6] text-[#d9d4ca]">
              Korea, then 10 1234 5678, is sent as +82 10 1234 5678. A send still shows the full number and waits for
              confirm. A request still asks, because it is created immediately.
            </p>
          </div>
        </div>

        <button
          type="submit"
          disabled={saving || value === saved}
          className="btn-sun h-[50px] w-full rounded-[12px] font-sans text-[15px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving' : value ? 'Save' : saved ? 'Clear country' : 'Save'}
        </button>
      </form>
    </section>
  );
}

function PhoneGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10.5 18h3" strokeLinecap="round" />
    </svg>
  );
}
