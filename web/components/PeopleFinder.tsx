'use client';

import { useEffect, useState } from 'react';
import { PersonRow } from './PersonRow';
import type { PublicPerson } from '../lib/follows.ts';

/**
 * Search usernames and a short set of suggested profiles.
 * Opening a row goes to that profile. Nothing here follows or pays.
 */
export function PeopleFinder({ initialQuery = '' }: { initialQuery?: string }) {
  const seed = initialQuery.trim().slice(0, 24);
  const [draft, setDraft] = useState(seed);
  const [query, setQuery] = useState(seed);
  const [suggestions, setSuggestions] = useState<PublicPerson[]>([]);
  const [results, setResults] = useState<PublicPerson[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 10000);
    setError('');
    const q = query.length >= 2 ? `?q=${encodeURIComponent(query)}` : '';
    fetch(`/api/people${q}`, { signal: ac.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setSuggestions([]);
          setResults([]);
          setError(typeof data.error === 'string' ? data.error : 'Could not search.');
          return;
        }
        setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
        setResults(Array.isArray(data.results) ? data.results : []);
      })
      .catch(() => {
        if (!ac.signal.aborted) setError('Could not search.');
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [query]);

  const searching = query.length >= 2;
  const rows = searching ? results : suggestions;

  return (
    <div className="mx-auto w-full max-w-lg md:max-w-5xl">
      <label className="relative block">
        <span className="sr-only">Search usernames</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#8d867c]"
        >
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
          <path d="M16 16.5L20 20.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search users..."
          autoComplete="off"
          maxLength={24}
          className="h-11 w-full rounded-full border border-[#2a2b30] bg-[#14120e] pl-11 pr-4 font-sans text-[15px] text-white outline-none placeholder:text-[#6f6a62] focus:border-[#f7d047]"
        />
      </label>
      <p className="m-0 mt-3 font-sans text-[13px] leading-relaxed text-[#8d867c]">Find a username and open that profile.</p>
      <p className="m-0 mt-5 font-sans text-[11px] uppercase tracking-[0.16em] text-[#8d867c]">
        {searching ? 'Matches' : 'Suggested'}
      </p>
      {error ? <p className="m-0 mt-3 font-sans text-[13px] text-[#e0b070]">{error}</p> : null}
      {rows === null && !error ? <p className="m-0 mt-3 font-sans text-[13px] text-[#8d867c]">Loading</p> : null}
      {rows && rows.length === 0 && !error ? (
        <div className="mt-3 rounded-[18px] border border-[#2a2b30] bg-[linear-gradient(180deg,rgba(247,208,71,0.05),transparent_36%),#101012] px-4 py-10 text-center">
          <span
            aria-hidden
            className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-[#f7d047]/50 bg-[#14120e] text-[#f7d047] shadow-[0_0_24px_rgba(247,208,71,0.16)]"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
              <path d="M16 16.5L20 20.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </span>
          <p className="m-0 font-sans text-[13px] text-[#c8c2b8]">
            {searching ? 'No matches.' : 'Search a username to open a profile.'}
          </p>
        </div>
      ) : null}
      {rows && rows.length ? (
        <ul className="m-0 mt-3 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((person) => (
            <li key={person.username}>
              <PersonRow username={person.username} displayName={person.displayName} layout="card" />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
