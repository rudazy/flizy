'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fade-up mx-auto max-w-md">
      <p className="text-xs uppercase tracking-[0.18em] text-gold">Welcome back</p>
      <h1 className="mt-3 font-sans text-3xl tracking-wide text-paper">Log in</h1>
      <p className="mt-2 text-sm text-muted">Open your dashboard to manage trusted people and WhatsApp.</p>

      <form onSubmit={onSubmit} className="card mt-8 space-y-5 p-6 md:p-8">
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            required
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
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {error ? <div className="alert alert-error">{error}</div> : null}
        <button className="btn btn-primary w-full" type="submit" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
        <p className="text-center text-sm text-muted">
          New here?{' '}
          <Link href="/signup" className="text-lime no-underline hover:text-gold">
            Create an account
          </Link>
        </p>
      </form>
    </div>
  );
}
