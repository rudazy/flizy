'use client';

import { useState } from 'react';
import { AppTopBar } from '../../../components/AppTopBar';
import { CopyButton } from '../../../components/CopyButton';
import { useDashboard } from '../../../components/DashboardProvider';
import { shortAddr } from '../../../lib/dashboardTypes';

export default function AccountPage() {
  const {
    data,
    busy,
    setMsg,
    generateLink,
    addTrusted,
    removeTrusted,
    setUnlockPin,
    setDailyLimit,
  } = useDashboard();

  const [addr, setAddr] = useState('');
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [removePassword, setRemovePassword] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [dailyLimit, setDailyLimitInput] = useState('');
  const [limitPassword, setLimitPassword] = useState('');

  if (!data) return null;

  async function onAddTrusted(e: React.FormEvent) {
    e.preventDefault();
    const ok = await addTrusted({ address: addr, label, password });
    if (ok) {
      setAddr('');
      setLabel('');
      setPassword('');
    }
  }

  async function onRemove(address: string) {
    if (!removePassword) {
      setRemoving(address);
      setMsg('Enter your password below, then click Remove again.');
      return;
    }
    const ok = await removeTrusted(address, removePassword);
    if (ok) {
      setRemovePassword('');
      setRemoving(null);
    }
  }

  async function onPin(e: React.FormEvent) {
    e.preventDefault();
    const ok = await setUnlockPin(pin);
    if (ok) setPin('');
  }

  async function onDailyLimit(e: React.FormEvent) {
    e.preventDefault();
    const raw = dailyLimit.trim();
    const limit = raw === '' ? null : Number(raw);
    if (raw !== '' && (!Number.isFinite(limit) || (limit as number) < 0)) {
      setMsg('Enter a number >= 0, or leave empty to clear.');
      return;
    }
    const ok = await setDailyLimit(limit, limitPassword);
    if (ok) setLimitPassword('');
  }

  const currentLimit =
    data.account.daily_send_limit_eth == null || data.account.daily_send_limit_eth === ''
      ? 'App default (no extra daily cap unless env sets one)'
      : `${data.account.daily_send_limit_eth} ETH / UTC day`;

  return (
    <div className="space-y-5">
      <AppTopBar title="Account" />

      {/* WhatsApp */}
      <section className="card p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="font-sans text-sm tracking-wide text-paper">WhatsApp link</p>
            <p className="mt-1 text-xs text-muted">Bind this account to the Flizy bot.</p>
          </div>
          <span className="badge badge-gold">{data.link ? 'Ready' : 'Needed'}</span>
        </div>

        <div className="mt-4 rounded border border-border bg-ink/80 p-3 text-xs text-muted">
          Generate a code, open WhatsApp, send the message. Do not type commands in groups or other
          people&apos;s chats.
        </div>

        <button
          type="button"
          className="btn btn-primary mt-4 w-full sm:w-auto"
          onClick={generateLink}
          disabled={busy === 'link'}
        >
          {busy === 'link' ? 'Generating...' : 'Generate link code'}
        </button>

        {data.link ? (
          <div className="mt-4 space-y-3 rounded border border-border bg-ink p-4">
            <p className="font-sans text-2xl tracking-wide text-lime">{data.link.code}</p>
            <p className="text-xs text-muted">
              Expires {new Date(data.link.expiresAt).toLocaleString()}
            </p>
            <div className="mono-box text-sm">flizy link {data.link.code}</div>
            <div className="flex flex-wrap gap-2">
              <CopyButton value={`flizy link ${data.link.code}`} label="Copy message" />
              <a
                href={data.link.waDeepLink}
                className="btn btn-primary text-sm"
                target="_blank"
                rel="noreferrer"
              >
                Open WhatsApp
              </a>
            </div>
          </div>
        ) : null}
      </section>

      {/* Trusted */}
      <section className="card p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="font-sans text-sm tracking-wide text-paper">Trusted wallets</p>
            <p className="mt-1 text-xs text-muted">Only these can receive sends.</p>
          </div>
          <span className="badge">{data.trusted.length} saved</span>
        </div>

        <form onSubmit={onAddTrusted} className="mt-4 grid gap-3">
          <div>
            <label className="label">Name (WhatsApp send target)</label>
            <input
              className="input"
              placeholder="nald, mum, junior"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">Wallet address</label>
            <input
              className="input"
              placeholder="0x..."
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">Your account password</label>
            <input
              className="input"
              type="password"
              placeholder="Confirm it is you"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy === 'trusted'}>
            {busy === 'trusted' ? 'Saving...' : 'Save trusted wallet'}
          </button>
        </form>

        <div className="mt-6 space-y-3">
          <p className="label">Saved</p>
          {data.trusted.length === 0 ? (
            <p className="text-sm text-muted">None yet.</p>
          ) : (
            data.trusted.map((t) => (
              <div
                key={t.address}
                className="flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-sm text-lime">{t.label || 'unnamed'}</p>
                  <p className="truncate text-xs text-muted">{t.address}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <CopyButton value={t.address} label="Copy" />
                  <button
                    type="button"
                    className="btn btn-ghost text-sm"
                    onClick={() => onRemove(t.address)}
                    disabled={busy === 'remove'}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          )}
          {data.trusted.length > 0 ? (
            <div className="pt-2">
              <label className="label">Password to remove a wallet</label>
              <input
                className="input"
                type="password"
                placeholder={
                  removing
                    ? `Password to remove ${shortAddr(removing)}`
                    : 'Enter password, then click Remove'
                }
                value={removePassword}
                onChange={(e) => setRemovePassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
          ) : null}
        </div>
      </section>

      {/* Daily limit — Policy Engine */}
      <section className="card p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="font-sans text-sm tracking-wide text-paper">Daily send limit</p>
            <p className="mt-1 text-xs text-muted">
              Enforced in Policy (WhatsApp + any future client). UTC day. Per-tx max still applies.
            </p>
          </div>
          <span className="badge">Policy</span>
        </div>
        <p className="mt-3 text-xs text-muted">Current: {currentLimit}</p>
        <form onSubmit={onDailyLimit} className="mt-4 grid gap-3">
          <div>
            <label className="label">Limit (ETH / day)</label>
            <input
              className="input"
              inputMode="decimal"
              placeholder="e.g. 0.05 — empty clears"
              value={dailyLimit}
              onChange={(e) => setDailyLimitInput(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Account password</label>
            <input
              className="input"
              type="password"
              required
              value={limitPassword}
              onChange={(e) => setLimitPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy === 'limit'}>
            {busy === 'limit' ? 'Saving...' : 'Save daily limit'}
          </button>
        </form>
      </section>

      {/* PIN */}
      <section className="card p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="font-sans text-sm tracking-wide text-paper">Unlock PIN</p>
            <p className="mt-1 text-xs text-muted">
              On WhatsApp: <span className="text-paper">flizy unlock 1234</span>
            </p>
          </div>
          <span className="badge">{data.account.has_pin ? 'Set' : 'Optional'}</span>
        </div>
        <form onSubmit={onPin} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            className="input"
            type="password"
            inputMode="numeric"
            minLength={4}
            maxLength={12}
            placeholder="4-12 digits"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />
          <button className="btn btn-primary" type="submit" disabled={busy === 'pin'}>
            {busy === 'pin' ? 'Saving...' : 'Save PIN'}
          </button>
        </form>
      </section>

      <section className="card p-4">
        <p className="font-sans text-sm tracking-wide text-paper">Security</p>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Signed in as <span className="text-paper">{data.account.email}</span>. Password is
          required to add or remove trusted wallets. Install this app from Chrome for faster access
          without browser chrome.
        </p>
        <a href="/docs" className="btn btn-ghost mt-3 text-sm">
          Security docs
        </a>
      </section>
    </div>
  );
}
