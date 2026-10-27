'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PersonRow } from './PersonRow';
import type { PublicPerson } from '../lib/follows.ts';

/**
 * Search usernames and a short set of suggested profiles.
 * Opening a row goes to that profile. Nothing here follows or pays.
 */
export function PeopleFinder({ signedIn }: { signedIn: boolean }) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
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
      <section className="relative overflow-hidden rounded-[20px] border border-[#3a3424] bg-[#100e0b] px-4 py-5 sm:px-7 sm:py-7">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-[#f7d047]/12 blur-3xl"
        />
        <div className="relative mb-5 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 font-sans text-[11px] uppercase tracking-[0.18em] text-[#f7d047]">Directory</p>
            <h1 className="m-0 mt-1 font-sans text-[28px] font-semibold tracking-wide text-white sm:text-[36px]">People</h1>
            <p className="m-0 mt-2 max-w-xl font-sans text-[13px] leading-relaxed text-[#c8c2b8]">
              Find a username and open that profile.
            </p>
          </div>
          <Link
            href={signedIn ? '/dashboard' : '/login'}
            className="inline-flex min-h-[44px] shrink-0 items-center font-sans text-[13px] text-[#c8c2b8] no-underline hover:text-white"
          >
            {signedIn ? 'Home' : 'Sign in'}
          </Link>
        </div>
        <label className="relative block">
          <span className="sr-only">Search usernames</span>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search a username"
            autoComplete="off"
            className="h-12 w-full rounded-[14px] border border-[#3a3424] bg-[#0c0b09] px-4 font-sans text-[15px] text-white outline-none placeholder:text-[#6f6a62] focus:border-[#f7d047]"
          />
        </label>
      </section>
      <p className="m-0 mt-5 font-sans text-[11px] uppercase tracking-[0.16em] text-[#8d867c]">
        {searching ? 'Matches' : 'Suggested'}
      </p>
      {error ? <p className="m-0 mt-3 font-sans text-[13px] text-[#e0b070]">{error}</p> : null}
      {rows === null && !error ? <p className="m-0 mt-3 font-sans text-[13px] text-[#8d867c]">Loading</p> : null}
      {rows && rows.length === 0 && !error ? (
        <p className="m-0 mt-3 rounded-[16px] border border-[#2a2b30] bg-[#101012] px-4 py-8 text-center font-sans text-[13px] text-[#c8c2b8]">
          {searching ? 'No matches.' : 'Search a username to open a profile.'}
        </p>
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
