'use client';

import { useEffect, useMemo, useState } from 'react';
import { AccordionSection } from '../../../components/Accordion';
import { AppTopBar } from '../../../components/AppTopBar';
import { AppPage, AppSection, AppSectionNav } from '../../../components/AppSection';
import { CopyButton } from '../../../components/CopyButton';
import { useDashboard } from '../../../components/DashboardProvider';
import { LinkedAccounts } from '../../../components/LinkedAccounts';
import { shortAddr } from '../../../lib/dashboardTypes';

export default function AccountPage() {
  const {
    data,
    busy,
    msg,
    setMsg,
    setBusy,
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
  const [pinPassword, setPinPassword] = useState('');
  const [dailyLimit, setDailyLimitInput] = useState('');
  const [limitPassword, setLimitPassword] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const defaults = useMemo((): Record<string, boolean> => {
    if (!data) {
      return {
        chat: true,
        platforms: true,
        trusted: false,
        pin: false,
        limits: false,
        security: false,
      };
    }
    return {
      chat: true,
      platforms: true,
      trusted: data.trusted.length === 0,
      pin: !data.account.has_pin,
      limits: false,
      security: false,
    };
  }, [data]);

  useEffect(() => {
    setOpen((prev) => {
      if (Object.keys(prev).length) return prev;
      return defaults;
    });
  }, [defaults]);

  if (!data) return null;

  function toggle(id: string) {
    setOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function onSignOut() {
    setBusy('logout');
    setMsg('');
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setMsg(json.error || 'Could not sign out. Try again.');
        return;
      }
      window.location.href = '/login';
    } catch {
      setMsg('Could not sign out. Try again.');
    } finally {
      setBusy('');
    }
  }

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
    const ok = await setUnlockPin(pin, pinPassword);
    if (ok) {
      setPin('');
      setPinPassword('');
      setMsg(
        'Unlock PIN saved. In chat: flizy lock or /lock · flizy unlock or /unlock with PIN or password.'
      );
    }
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
      ? 'App default'
      : `${data.account.daily_send_limit_eth} ETH / UTC day`;

  const nav = [
    { id: 'chat', label: 'Chat', badge: data.link ? undefined : '!' },
    { id: 'platforms', label: 'Platforms' },
    { id: 'trusted', label: 'Trusted', badge: String(data.trusted.length) },
    { id: 'pin', label: 'PIN', badge: data.account.has_pin ? undefined : '!' },
    { id: 'limits', label: 'Limits' },
    { id: 'security', label: 'Security' },
  ];

  return (
    <AppPage>
      <AppTopBar title="Account" />
      {msg ? <div className="alert alert-ok text-sm">{msg}</div> : null}

      {/* Jump chips — find a block without scrolling the whole page */}
      <AppSectionNav items={nav} />

      <AppSection
        title="Profile"
        helper="Signed-in account. Username (when shipped) will live here too."
      >
        <p className="text-sm text-paper">{data.account.email}</p>
        {data.account.display_name ? (
          <p className="mt-1 text-xs text-muted">{data.account.display_name}</p>
        ) : (
          <p className="mt-1 text-xs text-muted">No display name yet</p>
        )}
      </AppSection>

      {/* Chat apps */}
      <div id="chat" className="scroll-mt-24">
        <AccordionSection
          id="chat"
          title="Chat apps"
          badge={data.link ? 'Ready' : 'Needed'}
          open={Boolean(open.chat)}
          onToggle={toggle}
        >
          <p className="text-xs leading-relaxed text-muted">
            Generate a one-time code, then open WhatsApp or Telegram. Both can link to this
            account. A code works once — generate again for the second app.
          </p>
          <button
            type="button"
            className="btn btn-primary mt-4 w-full py-3.5 text-base font-semibold"
            onClick={() => generateLink()}
            disabled={busy === 'link'}
          >
            {busy === 'link' ? 'Generating...' : data.link ? 'Generate a new code' : 'Generate code'}
          </button>
          {data.link ? (
            <div className="mt-4 space-y-3 rounded border border-border bg-ink p-4">
              <p className="font-sans text-2xl tracking-wide text-lime">{data.link.code}</p>
              <p className="text-xs text-muted">
                Expires {new Date(data.link.expiresAt).toLocaleString()}
              </p>
              <div className="mono-box text-sm">flizy link {data.link.code}</div>
              <a
                href={data.link.waDeepLink}
                className="btn btn-primary flex w-full items-center justify-center py-3 text-sm font-semibold no-underline"
                target="_blank"
                rel="noreferrer"
              >
                Link WhatsApp
              </a>
              {data.link.telegramDeepLink ? (
                <a
                  href={data.link.telegramDeepLink}
                  className="btn btn-primary flex w-full items-center justify-center py-3 text-sm font-semibold no-underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Link Telegram
                </a>
              ) : null}
              <CopyButton value={`flizy link ${data.link.code}`} label="Copy message" />
            </div>
          ) : null}
        </AccordionSection>
      </div>

      {/* Platforms — slot for GitHub now, Discord/X later */}
      <div id="platforms" className="scroll-mt-24">
        <AccordionSection
          id="platforms"
          title="Platforms"
          badge="GitHub"
          open={Boolean(open.platforms)}
          onToggle={toggle}
        >
          <p className="mb-4 text-xs leading-relaxed text-muted">
            Link GitHub so people can send claims to @you on github. Discord and X use the same
            place when they ship.
          </p>
          <LinkedAccounts />
        </AccordionSection>
      </div>

      {/* Trusted */}
      <div id="trusted" className="scroll-mt-24">
        <AccordionSection
          id="trusted"
          title="Trusted wallets"
          badge={`${data.trusted.length}`}
          open={Boolean(open.trusted)}
          onToggle={toggle}
        >
          <p className="text-xs text-muted">Only these names can receive chat sends.</p>
          <form onSubmit={onAddTrusted} className="mt-4 grid gap-3">
            <div>
              <label className="label">Name</label>
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
              <label className="label">Account password</label>
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
                <label className="label">Password to remove</label>
                <input
                  className="input"
                  type="password"
                  placeholder={
                    removing
                      ? `Password to remove ${shortAddr(removing)}`
                      : 'Enter password, then Remove'
                  }
                  value={removePassword}
                  onChange={(e) => setRemovePassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
            ) : null}
          </div>
        </AccordionSection>
      </div>

      {/* PIN */}
      <div id="pin" className="scroll-mt-24">
        <AccordionSection
          id="pin"
          title="Unlock PIN"
          badge={data.account.has_pin ? 'Set' : 'Required'}
          open={Boolean(open.pin)}
          onToggle={toggle}
        >
          <p className="text-xs text-muted">
            For <span className="text-paper">flizy lock</span> /{' '}
            <span className="text-paper">unlock</span>. Password also works.
          </p>
          <form onSubmit={onPin} className="mt-4 grid gap-3">
            <div>
              <label className="label">New PIN</label>
              <input
                className="input"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                minLength={4}
                maxLength={12}
                placeholder="4-12 digits"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                required
              />
            </div>
            <div>
              <label className="label">Account password</label>
              <input
                className="input"
                type="password"
                placeholder="Confirm it is you"
                value={pinPassword}
                onChange={(e) => setPinPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy === 'pin'}>
              {busy === 'pin' ? 'Saving...' : data.account.has_pin ? 'Update PIN' : 'Save PIN'}
            </button>
          </form>
        </AccordionSection>
      </div>

      {/* Limits */}
      <div id="limits" className="scroll-mt-24">
        <AccordionSection
          id="limits"
          title="Daily send limit"
          badge="Policy"
          open={Boolean(open.limits)}
          onToggle={toggle}
        >
          <p className="text-xs text-muted">Current: {currentLimit}</p>
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
        </AccordionSection>
      </div>

      {/* Security */}
      <div id="security" className="scroll-mt-24">
        <AccordionSection
          id="security"
          title="Security"
          open={Boolean(open.security)}
          onToggle={toggle}
        >
          <p className="text-xs leading-relaxed text-muted">
            Signed in as <span className="text-paper">{data.account.email}</span>. Password is
            required to change trusted wallets and limits.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="/docs" className="btn btn-ghost text-sm no-underline">
              Security docs
            </a>
            <button
              type="button"
              className="btn btn-ghost text-sm"
              onClick={() => void onSignOut()}
              disabled={busy === 'logout'}
            >
              {busy === 'logout' ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </AccordionSection>
      </div>
    </AppPage>
  );
}
