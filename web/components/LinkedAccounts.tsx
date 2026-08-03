'use client';

/**
 * Platform identities on the Account tab.
 *
 * Unlinked shows one button. Linked shows the platform, the handle and a
 * verified mark, plus the way back out. The handle is rendered as returned by
 * the server, which already put it through displaySafeLabel, and it is never
 * treated as an identifier: the numeric id it routes on is not sent here at all.
 *
 * Unlink asks for the password because it changes where future payments can go,
 * and because it is the only way to move an identity to another account.
 */

import { useCallback, useEffect, useState } from 'react';

type Identity = {
  channel: string;
  handle: string | null;
  linked_at: string | null;
};

const CHANNEL_LABELS: Record<string, string> = {
  github: 'GitHub',
};

/** Status codes the OAuth callback redirects back with. */
const CALLBACK_MESSAGES: Record<string, { text: string; tone: 'ok' | 'warn' }> = {
  linked: { text: 'GitHub linked.', tone: 'ok' },
  cancelled: { text: 'GitHub linking was cancelled.', tone: 'warn' },
  identity_taken: {
    text: 'That GitHub is already linked to another Flizy account. Unlink it there first.',
    tone: 'warn',
  },
  already_linked: {
    text: 'This account already has a different GitHub linked. Unlink it first.',
    tone: 'warn',
  },
  state_invalid: { text: 'That link request expired or did not match. Try again.', tone: 'warn' },
  exchange_failed: { text: 'GitHub did not complete the sign in. Try again.', tone: 'warn' },
  rate_limited: { text: 'Too many attempts. Wait a little and try again.', tone: 'warn' },
  login_required: { text: 'Log in and try again.', tone: 'warn' },
  unavailable: { text: 'GitHub linking is not available right now.', tone: 'warn' },
  error: { text: 'Something went wrong. Try again.', tone: 'warn' },
};

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

  // Read the callback result from the URL, then strip it so a refresh does not
  // show a stale outcome. Deliberately not useSearchParams, which would pull
  // this subtree into a Suspense boundary for no gain.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('github');
    if (!status) return;
    setNotice(CALLBACK_MESSAGES[status] || CALLBACK_MESSAGES.error);
    params.delete('github');
    const rest = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
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

  const github = (identities || []).find((i) => i.channel === 'github') || null;

  // Content-only (parent Account subsection supplies the card chrome)
  return (
    <div>
      {notice ? (
        <p
          className={`mb-3 rounded-md border px-3 py-2 font-mono text-[11px] ${
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
      ) : github ? (
        <div className="rounded-md border border-border bg-ink/40 px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-sans text-sm text-paper">{CHANNEL_LABELS.github}</span>
                <VerifiedMark />
              </div>
              <p className="mt-0.5 truncate font-mono text-xs text-lime">
                {github.handle ? `@${github.handle}` : 'linked'}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs"
              disabled={busy}
              onClick={() => onUnlink('github')}
            >
              {busy ? 'Working...' : 'Unlink'}
            </button>
          </div>

          {unlinking === 'github' ? (
            <div className="mt-3 space-y-2">
              <p className="font-mono text-[11px] text-muted">
                Unlinking frees this GitHub for another account and stops claims to it here.
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
      ) : (
        <div className="rounded-md border border-border bg-ink/40 px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-sans text-sm text-paper">{CHANNEL_LABELS.github}</p>
              <p className="mt-0.5 font-mono text-xs text-muted">Not linked</p>
            </div>
            <a
              href="/api/auth/github/start"
              className="btn btn-primary shrink-0 px-3 py-1.5 text-xs no-underline"
            >
              Link GitHub
            </a>
          </div>
        </div>
      )}

      <p className="mt-3 font-mono text-[10px] text-muted">
        Discord and X: same list when they ship. One identity per platform.
      </p>
    </div>
  );
}
