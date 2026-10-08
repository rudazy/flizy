'use client';

/**
 * Platform identities on the Account tab: GitHub, Discord, X.
 * Bind via OAuth; unlink behind password. Numeric ids never leave the server.
 */

import { useCallback, useEffect, useState } from 'react';
import { HeroArt, PREF_CARD, PrefHero } from './AccountPrefs';
import { BrandTile, ConfirmPassword, GhostButton, InfoNote, LinkedChip, brandCard } from './AccountConnections';

type Identity = {
  channel: string;
  handle: string | null;
  linked_at: string | null;
};

const PLATFORMS: Array<{
  channel: 'github' | 'discord' | 'x';
  label: string;
  startHref: string;
  queryKey: string;
}> = [
  { channel: 'github', label: 'GitHub', startHref: '/api/auth/github/start', queryKey: 'github' },
  {
    channel: 'discord',
    label: 'Discord',
    startHref: '/api/auth/discord/start',
    queryKey: 'discord',
  },
  { channel: 'x', label: 'X', startHref: '/api/auth/x/start', queryKey: 'x' },
];

function callbackMessage(
  platform: string,
  status: string
): { text: string; tone: 'ok' | 'warn' } {
  const name = platform === 'x' ? 'X' : platform === 'discord' ? 'Discord' : 'GitHub';
  const map: Record<string, { text: string; tone: 'ok' | 'warn' }> = {
    linked: { text: `${name} linked.`, tone: 'ok' },
    cancelled: { text: `${name} linking was cancelled.`, tone: 'warn' },
    identity_taken: {
      text: `That ${name} is already linked to another Flizy account. Unlink it there first.`,
      tone: 'warn',
    },
    already_linked: {
      text: `This account already has a different ${name} linked. Unlink it first.`,
      tone: 'warn',
    },
    state_invalid: {
      text: 'That link request expired or did not match. Try again.',
      tone: 'warn',
    },
    exchange_failed: {
      text: `${name} did not complete the sign in. Try again.`,
      tone: 'warn',
    },
    project_required: {
      text:
        'X blocked profile read (API access). Your app settings look fine — Free tier often cannot call /2/users/me. On developer.x.com open the Project → Products / Access and enable a paid tier (e.g. Basic), wait a few minutes, then Link X again.',
      tone: 'warn',
    },
    unauthorized: {
      text: 'X rejected the app credentials or scopes. Check Client ID/Secret and App permissions, then try again.',
      tone: 'warn',
    },
    rate_limited: { text: 'Too many attempts. Wait a little and try again.', tone: 'warn' },
    login_required: { text: 'Log in and try again.', tone: 'warn' },
    unavailable: {
      text: `${name} linking is not available right now (app credentials missing).`,
      tone: 'warn',
    },
    error: { text: 'Something went wrong. Try again.', tone: 'warn' },
  };
  return map[status] || map.error;
}

/** Gold seal with a tick, next to a linked platform's name. */
function VerifiedMark() {
  return (
    <svg viewBox="0 0 24 24" aria-label="Verified" role="img" className="h-[20px] w-[20px] shrink-0">
      <path
        fill="#f7d047"
        d="M12 1.8l2.4 1.7 2.9-.3 1.2 2.7 2.7 1.2-.3 2.9 1.7 2.4-1.7 2.4.3 2.9-2.7 1.2-1.2 2.7-2.9-.3L12 22.2l-2.4-1.7-2.9.3-1.2-2.7-2.7-1.2.3-2.9L1.4 12l1.7-2.4-.3-2.9 2.7-1.2 1.2-2.7 2.9.3z"
      />
      <path d="M7.8 12.3l2.8 2.8 5.6-6" fill="none" stroke="#0b0b0b" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LinkedAccounts() {
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [password, setPassword] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/identity', { cache: 'no-store' });
      if (!res.ok) {
        setIdentities([]);
        return;
      }
      const body = await res.json();
      setIdentities(Array.isArray(body.identities) ? body.identities : []);
    } catch {
      setIdentities([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    for (const p of PLATFORMS) {
      const status = params.get(p.queryKey);
      if (!status) continue;
      setNotice(callbackMessage(p.channel, status));
      params.delete(p.queryKey);
      const rest = params.toString();
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}${rest ? `?${rest}` : ''}`
      );
      break;
    }
  }, []);

  /** Open the password prompt for a row, or close it if it is already open. */
  function toggleUnlink(channel: string) {
    if (unlinking === channel) {
      setUnlinking(null);
      setPassword('');
      setNotice(null);
      return;
    }
    // Clear on every open: a password typed for one platform must never carry
    // over and authorise a different one.
    setUnlinking(channel);
    setPassword('');
    setNotice(null);
  }

  async function confirmUnlink(channel: string) {
    if (!password) {
      setNotice({ text: 'Enter your account password to confirm.', tone: 'warn' });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/identity', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ text: body.error || 'Could not unlink.', tone: 'warn' });
        return;
      }
      setPassword('');
      setUnlinking(null);
      setNotice({ text: 'Unlinked.', tone: 'ok' });
      await load();
    } catch {
      setNotice({ text: 'Could not unlink. Try again.', tone: 'warn' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={PREF_CARD}>
      <PrefHero
        eyebrow="Platforms"
        title="Connect your"
        accent="platforms"
        text="Link GitHub, Discord, or X so people can send claims to you on that platform."
        art={<HeroArt src="/account/platforms-hero.webp" />}
      />

      <div className="grid gap-3 px-4 pb-5 pt-2">
        {notice ? (
          <p
            role="status"
            className={`m-0 rounded-[12px] border px-3.5 py-2.5 font-sans text-[13px] ${
              notice.tone === 'ok' ? 'border-[#1f4a2c] bg-[#0f2a18] text-[#4ade80]' : 'border-[#5a4a1f] bg-[#16130b] text-sun'
            }`}
          >
            {notice.text}
          </p>
        ) : null}

        {identities === null ? (
          <p className="m-0 px-1 py-4 font-sans text-[13px] text-[#9a958c]">Loading...</p>
        ) : (
          PLATFORMS.map((p) => {
            const row = identities.find((i) => i.channel === p.channel) || null;
            const handle = row?.handle ? `@${row.handle}` : null;
            return (
              <div key={p.channel} className={`rounded-[16px] border p-4 ${brandCard(p.channel, Boolean(row))}`}>
                <div className="flex items-center gap-4">
                  <BrandTile brand={p.channel} dim={!row && p.channel === 'x'} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-sans text-[16px] font-semibold text-white">{p.label}</span>
                      {row ? (
                        <>
                          <VerifiedMark />
                          <LinkedChip />
                        </>
                      ) : null}
                    </div>
                    <p className={`m-0 mt-1 truncate font-sans text-[15px] ${row ? 'font-medium text-sun' : 'text-[#9a958c]'}`}>
                      {row ? handle || 'Linked' : 'Not linked'}
                    </p>
                  </div>
                  {row ? (
                    // X stays gated on purpose. Linking X is paused, so unlinking it
                    // would be a one-way door: the row would be gone with no way to
                    // put it back. Do not lift this until X linking works again.
                    <GhostButton disabled={busy || p.channel === 'x'} onClick={() => toggleUnlink(p.channel)}>
                      {unlinking === p.channel ? 'Cancel' : 'Unlink'}
                    </GhostButton>
                  ) : p.channel === 'x' ? (
                    <button
                      type="button"
                      disabled
                      title="X linking is temporarily unavailable"
                      className="btn-sun inline-flex h-[44px] shrink-0 items-center rounded-[10px] px-5 font-sans text-[14px] font-semibold opacity-50"
                    >
                      Link X
                    </button>
                  ) : (
                    <a
                      href={p.startHref}
                      className="btn-sun inline-flex h-[44px] shrink-0 items-center rounded-[10px] px-5 font-sans text-[14px] font-semibold no-underline"
                    >
                      Link {p.label}
                    </a>
                  )}
                </div>

                {row ? (
                  <div className="mt-4 flex items-center gap-2.5 border-t border-white/[0.06] pt-3 font-sans text-[13px] text-[#9a958c]">
                    <PersonGlyph />
                    {handle ? <span className="truncate">{handle}</span> : null}
                    {handle ? <span aria-hidden>·</span> : null}
                    <span>Verified identity</span>
                  </div>
                ) : null}

                {p.channel === 'x' ? (
                  <div className="mt-3">
                    <InfoNote tone="gold">
                      {row
                        ? 'X linking is temporarily disabled, so unlinking is held too - you could not link it back yet. It stays connected until X is available again.'
                        : 'X linking is temporarily disabled. You can still see it here; GitHub and Discord work.'}
                    </InfoNote>
                  </div>
                ) : null}

                {unlinking === p.channel ? (
                  <ConfirmPassword
                    intro={`Unlinking frees this ${p.label} for another account and stops claims to it here.`}
                    value={password}
                    onChange={setPassword}
                    onSubmit={() => void confirmUnlink(p.channel)}
                    onCancel={() => toggleUnlink(p.channel)}
                    busy={busy}
                    confirmLabel={`Confirm unlink ${p.label}`}
                    busyLabel="Unlinking..."
                  />
                ) : null}
              </div>
            );
          })
        )}

        <div className="mt-1 border-t border-[#26262a] pt-4">
          <InfoNote>One identity per platform. Money routes on the platform id, not the handle.</InfoNote>
        </div>
      </div>
    </section>
  );
}

function PersonGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5c1-4 4-6 7.5-6s6.5 2 7.5 6" />
    </svg>
  );
}
