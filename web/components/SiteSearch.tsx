'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { POPULAR_PLACES, matchHelp, matchPlaces, type SearchResult, type SearchResultKind } from '../lib/searchIndex';
import {
  ArrowRightIcon,
  CloseIcon,
  HelpIcon,
  HistoryIcon,
  NftsIcon,
  PeopleIcon,
  PersonIcon,
  SearchIcon,
  TasksIcon,
  TokensIcon,
} from './ExploreIcons';

/**
 * Search across the app. Places and help answers match as you type, in the
 * browser; tokens, projects, tasks, NFT collections and an exact @username
 * come from /api/search a moment later. Enter or a tap opens the result.
 */

const RECENT_KEY = 'flizy.search.recent';
const RECENT_MAX = 6;
const DEBOUNCE_MS = 200;

const GROUP_ORDER: Array<{ kind: SearchResultKind; label: string }> = [
  { kind: 'place', label: 'Places' },
  { kind: 'token', label: 'Tokens' },
  { kind: 'project', label: 'Projects' },
  { kind: 'task', label: 'Tasks' },
  { kind: 'nft', label: 'NFTs' },
  { kind: 'person', label: 'People' },
  { kind: 'help', label: 'Help' },
];

type Remote = { tokens: SearchResult[]; projects: SearchResult[]; tasks: SearchResult[]; nfts: SearchResult[]; people: SearchResult[] };

function kindIcon(kind: SearchResultKind) {
  if (kind === 'token') return <TokensIcon size={17} />;
  if (kind === 'project') return <PeopleIcon size={17} />;
  if (kind === 'task') return <TasksIcon size={17} />;
  if (kind === 'nft') return <NftsIcon size={17} />;
  if (kind === 'person') return <PersonIcon size={17} />;
  if (kind === 'help') return <HelpIcon size={17} />;
  return <ArrowRightIcon size={17} />;
}

/** The title with the typed text picked out in gold. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().replace(/^[@#$]/, '');
  if (!q) return <>{text}</>;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="text-sun">{text.slice(at, at + q.length)}</span>
      {text.slice(at + q.length)}
    </>
  );
}

function readRecent(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // Storage blocked (private mode): recent searches just are not kept.
  }
}

/** The search button for a header, and the panel it opens. */
export function SearchButton({ className, iconSize = 17, shortcut = true }: { className: string; iconSize?: number; shortcut?: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className} aria-label="Search Flizy" aria-haspopup="dialog">
        <SearchIcon size={iconSize} />
      </button>
      {open ? <SearchPanel onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SearchPanel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<Remote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const latest = useRef(0);

  useEffect(() => {
    setRecent(readRecent());
    inputRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Live results, a moment after typing stops. A slower, older reply never
  // replaces a newer one.
  useEffect(() => {
    const query = q.trim();
    setError('');
    if (query.length < 2) {
      setRemote(null);
      setLoading(false);
      return;
    }
    const id = ++latest.current;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const body = await res.json().catch(() => ({}));
        if (id !== latest.current) return;
        if (!res.ok) {
          setRemote(null);
          setError(typeof body.error === 'string' && res.status === 429 ? body.error : '');
        } else {
          setRemote((body.groups as Remote | null) || null);
        }
      } catch {
        if (id === latest.current) setRemote(null);
      } finally {
        if (id === latest.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [q]);

  const results = useMemo(() => {
    const local = [...matchPlaces(q), ...matchHelp(q)];
    const live = remote ? [...remote.tokens, ...remote.projects, ...remote.tasks, ...remote.nfts, ...remote.people] : [];
    const all = [...local, ...live];
    // One list in group order, which is also the order the arrow keys walk.
    return GROUP_ORDER.flatMap((g) => all.filter((r) => r.kind === g.kind));
  }, [q, remote]);

  useEffect(() => setActive(0), [results.length, q]);

  const go = useCallback(
    (result: SearchResult) => {
      const query = q.trim();
      if (query) {
        const next = [query, ...readRecent().filter((r) => r.toLowerCase() !== query.toLowerCase())];
        writeRecent(next);
      }
      onClose();
      router.push(result.href);
    },
    [q, onClose, router]
  );

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      go(results[active]);
    }
  }

  const query = q.trim();
  let index = -1;

  return createPortal(
    <div className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-[3px] sm:pt-[9vh]" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="mx-auto flex h-full w-full flex-col bg-[#0d0d0d] sm:h-auto sm:max-h-[78vh] sm:max-w-[640px] sm:rounded-[16px] sm:border sm:border-[#2a2a2a] sm:shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
      >
        <h2 id={titleId} className="sr-only">
          Search Flizy
        </h2>
        <div className="flex items-center gap-3 border-b border-[#222] px-4 pb-3 pt-[max(14px,env(safe-area-inset-top))] sm:pt-3.5">
          <SearchIcon size={19} className="shrink-0 text-sun" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pages, tokens, projects, tasks, @username"
            aria-label="Search Flizy"
            aria-controls="site-search-results"
            maxLength={64}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="h-11 min-w-0 flex-1 bg-transparent font-sans text-base text-[#f5f5f5] outline-none placeholder:text-[#7a7a7a]"
          />
          {q ? (
            <button type="button" onClick={() => setQ('')} className="hit-y-44 text-[#8f8f8f] hover:text-white" aria-label="Clear search">
              <CloseIcon size={16} />
            </button>
          ) : null}
          <button type="button" onClick={onClose} className="hit-y-44 shrink-0 font-sans text-sm text-[#bdbdbd] hover:text-white sm:hidden">
            Cancel
          </button>
          <kbd className="hidden rounded-[5px] border border-[#333] px-1.5 py-0.5 font-mono text-[11px] text-[#8f8f8f] sm:inline">Esc</kbd>
        </div>

        <div id="site-search-results" className="min-h-0 flex-1 overflow-y-auto px-2 py-2" role="listbox" aria-label="Results">
          {!query ? (
            <>
              {recent.length ? (
                <Section
                  label="Recent"
                  action={
                    <button
                      type="button"
                      onClick={() => {
                        writeRecent([]);
                        setRecent([]);
                      }}
                      className="font-sans text-xs text-[#8f8f8f] hover:text-white"
                    >
                      Clear
                    </button>
                  }
                >
                  <div className="flex flex-wrap gap-2 px-2 pb-1">
                    {recent.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setQ(r)}
                        className="hit-y-44 inline-flex h-9 items-center gap-1.5 rounded-full border border-[#2e2e2e] px-3 font-sans text-sm text-[#e6e6e6] hover:border-sun/50"
                      >
                        <HistoryIcon size={13} className="text-[#8f8f8f]" />
                        {r}
                      </button>
                    ))}
                  </div>
                </Section>
              ) : null}
              <Section label="Popular">
                {POPULAR_PLACES.map((r) => (
                  <Row key={r.href} result={r} query="" active={false} onPick={() => go(r)} onHover={() => undefined} />
                ))}
              </Section>
            </>
          ) : (
            <>
              {GROUP_ORDER.map((g) => {
                const rows = results.filter((r) => r.kind === g.kind);
                if (!rows.length) return null;
                return (
                  <Section key={g.kind} label={g.label}>
                    {rows.map((r) => {
                      index += 1;
                      const mine = index;
                      return (
                        <Row
                          key={`${r.kind}-${r.href}`}
                          result={r}
                          query={query}
                          active={active === mine}
                          onPick={() => go(r)}
                          onHover={() => setActive(mine)}
                        />
                      );
                    })}
                  </Section>
                );
              })}
              {loading ? <p className="m-0 px-3 py-2 font-sans text-xs text-[#8f8f8f]">Searching tokens, projects, tasks and NFTs...</p> : null}
              {error ? <p className="m-0 px-3 py-2 font-sans text-xs text-[#e0b070]">{error}</p> : null}
              {!loading && !results.length ? (
                <div className="px-3 py-6">
                  <p className="m-0 font-sans text-sm text-[#e6e6e6]">Nothing found for &ldquo;{query}&rdquo;.</p>
                  <p className="m-0 mt-1 font-sans text-xs text-[#8f8f8f]">Try a page name like Fund or PIN, a token, a project, a task number like #142, or an exact @username.</p>
                  <div className="mt-4">
                    <Section label="Popular">
                      {POPULAR_PLACES.map((r) => (
                        <Row key={r.href} result={r} query="" active={false} onPick={() => go(r)} onHover={() => undefined} />
                      ))}
                    </Section>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="hidden items-center gap-4 border-t border-[#222] px-4 py-2.5 font-mono text-[11px] text-[#7a7a7a] sm:flex">
          <span>↑ ↓ to move</span>
          <span>Enter to open</span>
          <span>/ or Ctrl K to search</span>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <p className="m-0 font-sans text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8f8f8f]">{label}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

function Row({
  result,
  query,
  active,
  onPick,
  onHover,
}: {
  result: SearchResult;
  query: string;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onPick}
      onMouseEnter={onHover}
      className={`flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors ${active ? 'bg-sun-wash' : 'hover:bg-[#161616]'}`}
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border ${active ? 'border-sun/40 text-sun' : 'border-[#2a2a2a] text-[#cfcfcf]'}`}>
        {kindIcon(result.kind)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[15px] text-[#f5f5f5]">
          <Highlight text={result.title} query={query} />
        </span>
        <span className="block truncate font-sans text-xs text-[#8f8f8f]">{result.subtitle}</span>
      </span>
      {active ? <ArrowRightIcon size={15} className="shrink-0 text-sun" /> : null}
    </button>
  );
}
