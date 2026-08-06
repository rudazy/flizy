'use client';

/**
 * After email verify: require Flizy @username (and optional display name)
 * before any dashboard features.
 */

import { useState } from 'react';
import { useDashboard } from './DashboardProvider';
import { validateUsername } from '../lib/username';

export function ProfileCompleteGate() {
  const { load, setMsg } = useDashboard();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const check = validateUsername(username);
    if (!check.ok) {
      setError(check.error);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/account/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: check.username,
          displayName: displayName.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not save profile');
      setMsg('Profile saved. Welcome to Flizy.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save profile');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fade-up mx-auto max-w-md space-y-6 py-10">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-gold">Almost done</p>
        <h1 className="mt-2 font-sans text-3xl tracking-wide text-paper">Choose your name</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Pick a Flizy <span className="font-mono text-paper">@username</span> so people recognize
          you when you claim. Display name is optional (any language).
        </p>
      </div>

      {error ? <div className="alert alert-error text-sm">{error}</div> : null}

      <form onSubmit={(e) => void onSubmit(e)} className="card space-y-5 p-6">
        <div>
          <label className="label" htmlFor="gate-username">
            Username
          </label>
          <input
            id="gate-username"
            className="input"
            placeholder="letters and numbers"
            value={username}
            onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9@]/g, ''))}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={24}
            required
          />
          <p className="mt-1.5 text-xs text-muted">
            Starts with a letter. a–z and 0–9 only. You can change it once every 30 days later.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="gate-display-name">
            Display name <span className="text-muted">(optional)</span>
          </label>
          <input
            id="gate-display-name"
            className="input"
            placeholder="How you want to appear"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value.slice(0, 64))}
            autoComplete="nickname"
          />
          <p className="mt-1.5 text-xs text-muted">
            Any language is fine. Shown next to your @username in some places.
          </p>
        </div>
        <button className="btn btn-primary w-full py-3 font-semibold" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Continue to Flizy'}
        </button>
      </form>
    </div>
  );
}
