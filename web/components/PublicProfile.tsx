'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { PersonRow } from './PersonRow';
import { formatVolumeEth, profilePath, type ProfilePayload, type PublicPerson } from '../lib/follows.ts';

type ListSide = 'followers' | 'following';

/**
 * Someone else's profile, or your own public view.
 *
 * Follow changes the button and the counts only after the server accepts the
 * write. Your own profile offers Edit profile and never Follow. Pay is a
 * separate link. Neither action asks for a wallet.
 */
export function PublicProfile({ profile, initialList }: { profile: ProfilePayload; initialList: ListSide | null }) {
  const [followers, setFollowers] = useState(profile.followers);
  const [followingCount, setFollowingCount] = useState(profile.followingCount);
  const [following, setFollowing] = useState(profile.following);
  const [alerts, setAlerts] = useState(profile.alerts);
  const [copyTrade, setCopyTrade] = useState(profile.copyTrade);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [list, setList] = useState<ListSide | null>(initialList);
  const menuId = useId();
  const socialOpen = profile.isSelf || profile.showSocial;

  useEffect(() => {
    if (!menu) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenu(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  async function send(method: 'POST' | 'DELETE' | 'PATCH', body?: { alerts?: boolean; copyTrade?: boolean }) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/u/${encodeURIComponent(profile.username)}/follow`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Could not update this follow.');
        return;
      }
      setFollowing(data.following === true);
      setAlerts(data.alerts !== false);
      setCopyTrade(data.copyTrade === true);
      if (typeof data.followers === 'number') setFollowers(data.followers);
      if (typeof data.followingCount === 'number') setFollowingCount(data.followingCount);
      if (method === 'DELETE') setMenu(false);
    } catch {
      setError('Could not update this follow.');
    } finally {
      setBusy(false);
    }
  }

  if (list) {
    return (
      <FollowList
        username={profile.username}
        side={list}
        onBack={() => setList(null)}
      />
    );
  }

  const loginHref = `/login?next=${encodeURIComponent(profilePath(profile.username))}`;
  const activityOpen = profile.isSelf || profile.showActivity;
  const showCopy = !profile.isSelf && following;

  return (
    <div className="mx-auto w-full max-w-lg md:max-w-5xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link href="/people" className="inline-flex min-h-[44px] items-center font-sans text-[13px] text-[#f7d047] no-underline hover:text-[#ffe38a]">
          People
        </Link>
        <Link
          href={profile.signedIn ? '/dashboard' : '/login'}
          className="inline-flex min-h-[44px] items-center font-sans text-[13px] text-[#c8c2b8] no-underline hover:text-white"
        >
          {profile.signedIn ? 'Home' : 'Sign in'}
        </Link>
      </div>

      <section className="relative rounded-[20px] border border-[#3a3424] bg-[#100e0b] px-4 py-5 sm:px-7 sm:py-7">
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-[20px]">
          <div className="absolute -left-16 -top-24 h-56 w-56 rounded-full bg-[#f7d047]/15 blur-3xl" />
          <div className="absolute -bottom-28 -right-16 hidden h-56 w-56 rounded-full bg-[#f7d047]/10 blur-3xl lg:block" />
        </div>
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <span className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-full border-2 border-[#f7d047] bg-[#14120e] font-sans text-[30px] font-semibold text-[#f7d047] shadow-[0_0_0_8px_rgba(247,208,71,0.08)] sm:h-24 sm:w-24 sm:text-[40px]">
              {profile.username.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0">
              <h1 className="truncate font-sans text-[24px] font-semibold tracking-wide text-white sm:text-[32px]">
                @{profile.username}
              </h1>
              {profile.displayName ? (
                <p className="mt-1 truncate font-sans text-[13px] text-[#c8c2b8]">{profile.displayName}</p>
              ) : null}
            </div>
          </div>
          <div className="relative flex w-full flex-col gap-2 sm:flex-row lg:w-auto lg:shrink-0">
              {profile.isSelf ? (
                <Link
                  href="/dashboard/account"
                  className="inline-flex h-11 w-full items-center justify-center rounded-[12px] bg-[#f7d047] px-5 font-sans text-[14px] font-semibold text-[#1a1405] no-underline shadow-[0_8px_24px_rgba(247,208,71,0.16)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7d047] focus-visible:ring-offset-2 focus-visible:ring-offset-[#100e0b] sm:w-auto sm:min-w-[160px]"
                >
                  Edit profile
                </Link>
              ) : following ? (
                <button
                  type="button"
                  aria-expanded={menu}
                  aria-controls={menuId}
                  disabled={busy}
                  onClick={() => setMenu((open) => !open)}
                  className="inline-flex h-11 w-full items-center justify-center rounded-[12px] border border-[#f7d047] bg-transparent px-5 font-sans text-[14px] font-semibold text-[#f7d047] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7d047] disabled:opacity-60 sm:w-auto sm:min-w-[160px]"
                >
                  Following
                </button>
              ) : profile.signedIn ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void send('POST')}
                  className="inline-flex h-11 w-full items-center justify-center rounded-[12px] bg-[#f7d047] px-5 font-sans text-[14px] font-semibold text-[#1a1405] shadow-[0_8px_24px_rgba(247,208,71,0.16)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7d047] focus-visible:ring-offset-2 focus-visible:ring-offset-[#100e0b] disabled:opacity-60 sm:w-auto sm:min-w-[160px]"
                >
                  Follow
                </button>
              ) : (
                <Link
                  href={loginHref}
                  className="inline-flex h-11 w-full items-center justify-center rounded-[12px] bg-[#f7d047] px-5 font-sans text-[14px] font-semibold text-[#1a1405] no-underline shadow-[0_8px_24px_rgba(247,208,71,0.16)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7d047] focus-visible:ring-offset-2 focus-visible:ring-offset-[#100e0b] sm:w-auto sm:min-w-[180px]"
                >
                  Sign in to follow
                </Link>
              )}
              {profile.isSelf ? null : (
                <Link
                  href={`/pay/${encodeURIComponent(profile.username)}`}
                  className="inline-flex h-11 w-full items-center justify-center rounded-[12px] border border-[#5a5138] px-5 font-sans text-[14px] font-semibold text-[#f3ead2] no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7d047] sm:w-auto sm:min-w-[120px]"
                >
                  Pay
                </Link>
              )}
              {menu ? (
                <div
                  id={menuId}
                  className="absolute left-0 right-0 top-full z-20 mt-2 rounded-[14px] border border-[#3a3424] bg-[#16130e] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.45)] sm:right-auto sm:w-72"
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void send('DELETE')}
                    className="flex min-h-[44px] w-full items-center rounded-[8px] px-3 text-left font-sans text-[13px] text-[#f3f1ec] disabled:opacity-60"
                  >
                    Unfollow
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void send('PATCH', { alerts: !alerts })}
                    className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-[8px] px-3 text-left font-sans text-[13px] text-[#f3f1ec] disabled:opacity-60"
                  >
                    <span>Activity alerts</span>
                    <span className="text-[#f7d047]">{alerts ? 'On' : 'Off'}</span>
                  </button>
                  <p className="m-0 px-3 pb-2 font-sans text-[11px] leading-snug text-[#8d867c]">
                    Saved on this follow. No alert is sent yet.
                  </p>
                </div>
              ) : null}
            </div>
        </div>
        {error ? <p className="relative m-0 mt-3 font-sans text-[12px] text-[#e0b070]">{error}</p> : null}
      </section>

      <section className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat value={profile.volumeEth === null ? '-' : formatVolumeEth(profile.volumeEth)} label="Total volume" />
        <Stat value={profile.swaps === null ? '-' : String(profile.swaps)} label="Swaps" />
        <Stat
          value={followers === null ? '-' : String(followers)}
          label="Followers"
          onClick={socialOpen && followers !== null ? () => setList('followers') : undefined}
        />
        <Stat
          value={followingCount === null ? '-' : String(followingCount)}
          label="Following"
          onClick={socialOpen && followingCount !== null ? () => setList('following') : undefined}
        />
      </section>

      {profile.isSelf && !profile.showSocial ? (
        <p className="m-0 mt-3 font-sans text-[12px] text-[#8d867c]">Follower counts are hidden from others.</p>
      ) : null}
      {profile.isSelf && !profile.showStats ? (
        <p className="m-0 mt-2 font-sans text-[12px] text-[#8d867c]">Volume and swaps are hidden from others.</p>
      ) : null}

      <div
        className={`mt-4 grid grid-cols-1 gap-4 ${
          profile.followedBy.length ? 'lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start' : ''
        }`}
      >
        {profile.followedBy.length ? (
          <section className="order-2 rounded-[16px] border border-[#2a2b30] bg-[#101012] px-4 py-4 lg:order-1">
            <h2 className="m-0 font-sans text-[11px] font-medium uppercase tracking-[0.16em] text-[#8d867c]">Followed by</h2>
            <p className="m-0 mt-2 font-sans text-[13px] leading-relaxed text-[#c8c2b8]">
              {profile.followedBy.map((person, index) => (
                <span key={person.username}>
                  {index > 0 ? ', ' : null}
                  <Link href={profilePath(person.username)} className="text-[#f7d047] no-underline hover:text-[#ffe38a]">
                    @{person.username}
                  </Link>
                </span>
              ))}
              {profile.followedByCapped
                ? ' and others you follow'
                : profile.followedByMore > 0
                  ? ` and ${profile.followedByMore} more you follow`
                  : ', who you follow'}
            </p>
          </section>
        ) : null}

        <section className="order-1 rounded-[16px] border border-[#2a2b30] bg-[#101012] px-1 pb-4 lg:order-2">
          <div className="flex items-center justify-between gap-3 px-3.5 pt-4">
            <h2 className="m-0 font-sans text-[15px] font-semibold text-white">Activity</h2>
          </div>
          {activityOpen && profile.activity.length === 0 ? (
            <p className="m-0 px-3.5 pt-4 font-sans text-[13px] text-[#8d867c]">No swaps yet.</p>
          ) : null}
          {activityOpen && profile.activity.length > 0 ? (
            <ul className="m-0 mt-2 list-none p-0">
              {profile.activity.map((item, index) => (
                <li
                  key={`${item.detail}-${item.at}-${index}`}
                  className="flex min-h-[64px] items-center justify-between gap-3 border-t border-[#26262a] px-3.5 py-2.5"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#3a3424] bg-[#14120e] font-sans text-[11px] font-semibold text-[#f7d047]">
                      {item.title.slice(0, 1)}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-sans text-[14px] font-semibold text-white">{item.title}</span>
                      <span className="block truncate font-sans text-[12px] text-[#c8c2b8]">{item.detail}</span>
                    </span>
                  </span>
                  {item.at ? <span className="shrink-0 font-sans text-[12px] text-[#8d867c]">{item.at}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {!activityOpen ? (
            <div className="mx-3.5 mt-4 h-20 rounded-[12px] border border-dashed border-[#3a3424] bg-[radial-gradient(ellipse_at_top,rgba(247,208,71,0.06),transparent_68%)] sm:h-28" />
          ) : null}
          {profile.isSelf && !profile.showActivity ? (
            <p className="m-0 px-3.5 pt-3 font-sans text-[12px] text-[#8d867c]">Activity is hidden from others.</p>
          ) : null}
          {showCopy ? (
            <div className="mx-3.5 mt-4 flex items-center justify-between gap-3 rounded-[12px] border border-[#3a3424] bg-[#14120e] px-3 py-2.5">
              <p className="m-0 min-w-0 font-sans text-[11px] leading-snug text-[#8d867c]">
                Saved on this follow. Nothing is copied yet.
              </p>
              <span className="inline-flex shrink-0 items-center gap-2">
                <span className="font-sans text-[10px] uppercase tracking-[0.14em] text-[#c8c2b8]">Copy</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={copyTrade}
                  aria-label="Copy trade"
                  disabled={busy}
                  onClick={() => void send('PATCH', { copyTrade: !copyTrade })}
                  className={`hit-44 relative h-[14px] w-[26px] shrink-0 rounded-full disabled:opacity-60 ${
                    copyTrade ? 'bg-[#f7d047]' : 'bg-[#3a3a3e]'
                  }`}
                >
                  <span
                    className={`absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white ${copyTrade ? 'left-[14px]' : 'left-[2px]'}`}
                  />
                </button>
              </span>
            </div>
          ) : null}
        </section>
      </div>

      <Link
        href="/people"
        className="mt-4 flex min-h-[44px] items-center font-sans text-[13px] text-[#f7d047] no-underline hover:text-[#ffe38a]"
      >
        Find people
      </Link>
    </div>
  );
}

function Stat({ value, label, onClick }: { value: string; label: string; onClick?: () => void }) {
  const body = (
    <>
      <p className="font-sans text-[22px] font-semibold leading-none tracking-tight text-white sm:text-[26px]">{value}</p>
      <p className="mt-2 max-w-full px-1 font-sans text-[11px] font-medium uppercase leading-tight tracking-[0.08em] text-[#c8c2b8] sm:text-[12px] sm:tracking-[0.12em]">
        {label}
      </p>
    </>
  );
  const box =
    'flex min-h-[76px] min-w-0 flex-col items-center justify-center rounded-[14px] border border-[#2a2b30] bg-[#101012] px-2 py-3 text-center';
  if (!onClick) return <div className={box}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${box} transition-colors hover:border-[#5a5138] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7d047]`}
    >
      {body}
    </button>
  );
}

function FollowList({ username, side, onBack }: { username: string; side: ListSide; onBack: () => void }) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<PublicPerson[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft), 200);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 10000);
    setError('');
    fetch(`/api/u/${encodeURIComponent(username)}/${side}?q=${encodeURIComponent(query)}`, { signal: ac.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setPeople([]);
          setError(typeof data.error === 'string' ? data.error : 'Could not load this list.');
          return;
        }
        setPeople(Array.isArray(data.people) ? data.people : []);
      })
      .catch(() => {
        if (!ac.signal.aborted) setError('Could not load this list.');
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [username, side, query]);

  const title = side === 'followers' ? 'Followers' : 'Following';

  return (
    <div className="mx-auto w-full max-w-lg md:max-w-3xl">
      <button type="button" onClick={onBack} className="inline-flex min-h-[44px] items-center font-sans text-[13px] text-[#f7d047]">
        Back to profile
      </button>
      <section className="overflow-hidden rounded-[16px] border border-[#2a2b30] bg-[#101012]">
        <div className="px-4 pb-3 pt-4 sm:px-5">
          <h1 className="m-0 font-sans text-[22px] font-semibold tracking-wide text-white">
            {title} <span className="text-[#8d867c]">@{username}</span>
          </h1>
          <label className="mt-4 block">
            <span className="sr-only">Search {title.toLowerCase()}</span>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Search usernames"
              autoComplete="off"
              className="h-12 w-full rounded-[12px] border border-[#2a2b30] bg-[#0c0c0e] px-4 font-sans text-[15px] text-white outline-none placeholder:text-[#6f6a62] focus:border-[#f7d047]"
            />
          </label>
        </div>
        {error ? <p className="m-0 px-3.5 pb-3 font-sans text-[13px] text-[#e0b070]">{error}</p> : null}
        {people === null && !error ? <p className="m-0 px-3.5 pb-3 font-sans text-[13px] text-[#8d867c]">Loading</p> : null}
        {people && people.length === 0 && !error ? (
          <p className="m-0 px-3.5 pb-3 font-sans text-[13px] text-[#8d867c]">{query ? 'No matches.' : 'No one yet.'}</p>
        ) : null}
        {people && people.length ? (
          <ul className="m-0 list-none p-0">
            {people.map((person) => (
              <li key={person.username}>
                <PersonRow username={person.username} displayName={person.displayName} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
