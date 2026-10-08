'use client';

/**
 * After email verify: require Flizy @username (and optional display name)
 * before any dashboard features.
 */

import { useEffect, useRef, useState } from 'react';
import { useDashboard } from './DashboardProvider';
import { validateUsername } from '../lib/username';

export function ProfileCompleteGate() {
  const { load } = useDashboard();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const usernameRef = useRef<HTMLInputElement>(null);

  /**
   * Put the person back on the field that was refused.
   *
   * The error used to render above the heading while the button sits at the
   * bottom of the form. On a phone with the keyboard open the refusal appeared
   * off-screen, so pressing Continue looked like pressing a dead button: the
   * request ran, the answer arrived, and nothing visible happened. The message
   * now sits beside the button, and this moves focus back to the input so the
   * viewport follows even when it does not.
   */
  function refuse(message: string) {
    setError(message);
    usernameRef.current?.focus();
  }

  /**
   * What is wrong with what they have typed so far, or empty while it is fine
   * or still too early to say. Silent on an empty field: nagging someone who
   * has not started is noise, not help.
   */
  const trimmed = username.replace(/^@+/, '');
  const liveCheck = validateUsername(username);
  const liveProblem = !trimmed || liveCheck.ok || error ? '' : liveCheck.error;

  /**
   * Ask the server whether a well-formed name is free, while they are still
   * typing. Being told after pressing Continue is how somebody tries three
   * names and decides the button is broken.
   *
   * Debounced, and every answer is tagged with the name it was asked about, so
   * a slow reply for an earlier name cannot overwrite the verdict for what is
   * in the box now.
   */
  const [taken, setTaken] = useState<{ name: string; free: boolean; reason: string } | null>(null);

  useEffect(() => {
    if (!liveCheck.ok) {
      setTaken(null);
      return;
    }
    const name = liveCheck.username;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/account/username/check?u=${encodeURIComponent(name)}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && typeof body.available === 'boolean') {
          setTaken({ name, free: body.available, reason: String(body.reason || '') });
        }
      } catch {
        // A failed lookup is not a refusal. Stay quiet and let the save path
        // be the authority.
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // liveCheck is derived from username; depending on the name keeps this to
    // one request per settled value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCheck.ok ? liveCheck.username : '']);

  const verdict =
    !liveCheck.ok || error || !taken || taken.name !== liveCheck.username ? null : taken;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const check = validateUsername(username);
    if (!check.ok) {
      refuse(check.error);
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
      await load();
    } catch (err) {
      refuse(err instanceof Error ? err.message : 'Could not save profile');
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

      <form onSubmit={(e) => void onSubmit(e)} className="card space-y-5 p-6">
        <div>
          <label className="label" htmlFor="gate-username">
            Username
          </label>
          <input
            id="gate-username"
            ref={usernameRef}
            className="input"
            placeholder="letters and numbers"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value.replace(/[^a-zA-Z0-9@]/g, ''));
              // Clear a stale refusal as soon as they start changing it, so the
              // message beside the button always describes the current value.
              if (error) setError('');
            }}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={24}
            aria-invalid={error ? true : undefined}
            aria-describedby="gate-username-hint"
            required
          />
          <p id="gate-username-hint" className="mt-1.5 text-xs text-muted">
            Starts with a letter. a–z and 0–9 only. You can change it once every 30 days later.
          </p>
          {/*
            Live, before they ever press the button. The two rules people break
            are a name under three characters and one starting with a digit, and
            until now neither showed until after a submit that looked ignored.
          */}
          {liveProblem ? (
            <p className="mt-1.5 text-xs text-gold">{liveProblem}</p>
          ) : null}
          {/*
            Availability, before they commit to it. Silent while the lookup is
            in flight rather than flickering "checking" on every keystroke.
          */}
          {!liveProblem && verdict ? (
            <p
              className={`mt-1.5 text-xs ${verdict.free ? 'text-lime' : 'text-gold'}`}
              role="status"
            >
              {verdict.free ? `@${verdict.name} is available.` : verdict.reason}
            </p>
          ) : null}
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
        {/*
          Beside the button, not at the top of the page. This is the only place
          the person is looking when they press Continue.
        */}
        {error ? (
          <div className="alert alert-error text-sm" role="alert">
            {error}
          </div>
        ) : null}

        <button className="btn btn-primary w-full py-3 font-semibold" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Continue to Flizy'}
        </button>
      </form>
    </div>
  );
}
