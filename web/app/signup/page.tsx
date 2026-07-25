'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');
      router.push('/dashboard?welcome=1');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fade-up mx-auto grid max-w-5xl gap-10 lg:grid-cols-2 lg:items-start">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-gold">Get started</p>
        <h1 className="mt-3 font-sans text-3xl tracking-wide text-paper md:text-4xl">
          Create your Flizy account
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          After signup the dashboard gives you a button that opens the Flizy bot on WhatsApp or
          Telegram with your link code already filled in. You never need the bot number saved in
          contacts.
        </p>
        <ol className="mt-8 space-y-3 text-sm text-muted">
          <li className="flex gap-3">
            <span className="text-lime">1</span> Account + agent wallet
          </li>
          <li className="flex gap-3">
            <span className="text-lime">2</span> Set unlock PIN (required for lock/unlock)
          </li>
          <li className="flex gap-3">
            <span className="text-lime">3</span> Open the bot on WhatsApp or Telegram with your link
            code, then send
          </li>
        </ol>
      </div>

      <form onSubmit={onSubmit} className="card space-y-5 p-6 md:p-8">
        <div>
          <label className="label" htmlFor="name">
            Display name (optional)
          </label>
          <input
            id="name"
            className="input"
            placeholder="How we greet you"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="nickname"
          />
        </div>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            required
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            required
            minLength={8}
            placeholder="e.g. MyPass1!"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <p className="mt-2 text-xs leading-relaxed text-muted">
            No email code is sent. Use a strong password: at least 8 characters, with a letter, a
            number, and a special character (!@#$%…).
          </p>
        </div>
        {error ? <div className="alert alert-error">{error}</div> : null}
        <button className="btn btn-primary w-full" type="submit" disabled={loading}>
          {loading ? 'Creating account...' : 'Create account'}
        </button>
        <p className="text-center text-sm text-muted">
          Already have an account?{' '}
          <Link href="/login" className="text-lime no-underline hover:text-gold">
            Log in
          </Link>
        </p>
      </form>
    </div>
  );
}
