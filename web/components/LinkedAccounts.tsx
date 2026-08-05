'use client';

/**
 * Platform identities on the Account tab: GitHub, Discord, X.
 * Bind via OAuth; unlink behind password. Numeric ids never leave the server.
 */

import { useCallback, useEffect, useState } from 'react';

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

function VerifiedMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0 text-lime"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 8.5l3.5 3.5 7.5-8" />
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

  async function onUnlink(channel: string) {
    if (!password) {
      setUnlinking(channel);
      setNotice({ text: 'Enter your password below, then click Unlink again.', tone: 'warn' });
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
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {notice ? (
        <p
          className={`rounded-md border px-3 py-2 font-mono text-[11px] ${
            notice.tone === 'ok'
              ? 'border-lime/40 bg-lime/10 text-lime'
              : 'border-gold/40 bg-gold/10 text-gold'
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      {identities === null ? (
        <p className="font-mono text-xs text-muted">Loading...</p>
      ) : (
        PLATFORMS.map((p) => {
          const row = identities.find((i) => i.channel === p.channel) || null;
          return (
            <div
              key={p.channel}
              className="rounded-md border border-border bg-ink/40 px-3 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-sans text-sm text-paper">{p.label}</span>
                    {row ? <VerifiedMark /> : null}
                  </div>
                  <p
                    className={`mt-0.5 truncate font-mono text-xs ${
                      row ? 'text-lime' : 'text-muted'
                    }`}
                  >
                    {row ? (row.handle ? `@${row.handle}` : 'linked') : 'Not linked'}
                  </p>
                </div>
                {row ? (
                  <button
                    type="button"
                    className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs"
                    disabled={busy}
                    onClick={() => onUnlink(p.channel)}
                  >
                    {busy ? 'Working...' : 'Unlink'}
                  </button>
                ) : (
                  <a
                    href={p.startHref}
                    className="btn btn-primary shrink-0 px-3 py-1.5 text-xs no-underline"
                  >
                    Link {p.label}
                  </a>
                )}
              </div>

              {unlinking === p.channel ? (
                <div className="mt-3 space-y-2">
                  <p className="font-mono text-[11px] text-muted">
                    Unlinking frees this {p.label} for another account and stops claims to it
                    here.
                  </p>
                  <input
                    type="password"
                    className="input w-full"
                    placeholder="Account password"
                    value={password}
                    autoComplete="current-password"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              ) : null}
            </div>
          );
        })
      )}

      <p className="font-mono text-[10px] text-muted">
        One identity per platform. Money routes on the platform id, not the handle.
      </p>
    </div>
  );
}
