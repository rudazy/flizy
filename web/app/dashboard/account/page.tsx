'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppTopBar } from '../../../components/AppTopBar';
import {
  AppPage,
  AppSection,
  AppSlideNav,
  useSlide,
} from '../../../components/AppSection';
import { CopyButton } from '../../../components/CopyButton';
import { useDashboard } from '../../../components/DashboardProvider';
import { LanguageSelect, useLocale } from '../../../components/LocaleProvider';
import { LinkedAccounts } from '../../../components/LinkedAccounts';
import { shortAddr } from '../../../lib/dashboardTypes';
import type { LocaleCode } from '../../../lib/locale';

const SLIDES = [
  'profile',
  'language',
  'chat',
  'platforms',
  'trusted',
  'pin',
  'limits',
  'security',
] as const;

type SlideId = (typeof SLIDES)[number];

export default function AccountPage() {
  const search = useSearchParams();
  const { t, locale } = useLocale();
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
    setUsername,
    setAccountLocale,
  } = useDashboard();
  const [localeDraft, setLocaleDraft] = useState<LocaleCode>(locale);

  const [addr, setAddr] = useState('');
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [removePassword, setRemovePassword] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinPassword, setPinPassword] = useState('');
  const [dailyLimit, setDailyLimitInput] = useState('');
  const [limitPassword, setLimitPassword] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [chatLinks, setChatLinks] = useState<
    Array<{ channel: string; phone: string | null; has_phone: boolean }>
  >([]);
  const [unlinkChat, setUnlinkChat] = useState<string | null>(null);
  const [unlinkChatPassword, setUnlinkChatPassword] = useState('');
  const [emailList, setEmailList] = useState<{
    primary: string | null;
    additional: Array<{ id: string; email: string; verified: boolean }>;
    claimable: string[];
  } | null>(null);
  const [extraEmail, setExtraEmail] = useState('');
  const [extraEmailPassword, setExtraEmailPassword] = useState('');

  // Smart default slide when no ?s= — open the first thing that still needs work.
  const defaultSlide = useMemo((): SlideId => {
    if (!data) return 'profile';
    if (!data.account.has_pin) return 'pin';
    if (!data.link) return 'chat';
    if (search.get('github')) return 'platforms';
    return 'profile';
  }, [data, search]);

  const [slide, setSlide] = useSlide(SLIDES, defaultSlide);

  useEffect(() => {
    if (data?.account?.username) {
      setUsernameInput(data.account.username);
    }
  }, [data?.account?.username]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/account/emails', { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) {
          setEmailList({
            primary: body.primary || data?.account?.email || null,
            additional: Array.isArray(body.additional) ? body.additional : [],
            claimable: Array.isArray(body.claimable) ? body.claimable : [],
          });
        }
      } catch {
        if (!cancelled && data?.account?.email) {
          setEmailList({
            primary: data.account.email,
            additional: [],
            claimable: [data.account.email],
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data?.account?.email]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/identity', { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json();
        const rows = Array.isArray(body.identities) ? body.identities : [];
        if (!cancelled) {
          setChatLinks(
            rows.filter((r: { channel: string }) => r.channel === 'whatsapp' || r.channel === 'telegram')
          );
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, msg]);

  useEffect(() => {
    if (data?.account?.locale) {
      setLocaleDraft(data.account.locale as LocaleCode);
    } else {
      setLocaleDraft(locale);
    }
  }, [data?.account?.locale, locale]);

  // OAuth error/status lands with ?github= — always show Platforms slide.
  useEffect(() => {
    if (search.get('github')) setSlide('platforms');
  }, [search, setSlide]);

  if (!data) return null;

  const canChangeUsername = data.account.can_change_username !== false;
  const nextChange = data.account.username_next_change_at
    ? new Date(data.account.username_next_change_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;

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

  async function onUsername(e: React.FormEvent) {
    e.preventDefault();
    await setUsername(usernameInput);
  }

  async function onUnlinkChat(channel: string) {
    if (!unlinkChatPassword) {
      setUnlinkChat(channel);
      setMsg('Enter your password below, then click Unlink again.');
      return;
    }
    setBusy('unlink-chat');
    setMsg('');
    try {
      const res = await fetch('/api/identity', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, password: unlinkChatPassword }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(json.error || 'Could not unlink.');
        return;
      }
      setUnlinkChatPassword('');
      setUnlinkChat(null);
      setMsg(
        `${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} unlinked. Phone claims no longer match via that chat until you link again.`
      );
      setChatLinks((prev) => prev.filter((r) => r.channel !== channel));
    } catch {
      setMsg('Could not unlink. Try again.');
    } finally {
      setBusy('');
    }
  }

  const currentLimit =
    data.account.daily_send_limit_eth == null || data.account.daily_send_limit_eth === ''
      ? 'App default'
      : `${data.account.daily_send_limit_eth} ETH / UTC day`;

  const nav = [
    {
      id: 'profile',
      label: t('account.profile'),
      badge: data.account.username ? `@${data.account.username}` : undefined,
    },
    { id: 'language', label: t('account.language') },
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

      <AppSlideNav items={nav} activeId={slide} onSelect={setSlide} />

      {/* One slide at a time — chips switch the panel, they do not scroll the page */}
      {slide === 'profile' ? (
        <AppSection
          title={t('account.profile')}
          helper={t('account.profileHelper')}
          badge={data.account.username ? `@${data.account.username}` : 'Username?'}
          badgeTone={data.account.username ? 'lime' : 'gold'}
        >
          <p className="text-sm text-paper">{data.account.email}</p>
          <p className="mt-1 text-xs text-muted">
            Registration email — can receive email claims (sign up / log in proves ownership).
          </p>
          {data.account.display_name ? (
            <p className="mt-1 text-xs text-muted">{data.account.display_name}</p>
          ) : (
            <p className="mt-1 text-xs text-muted">No display name yet</p>
          )}

          <div className="mt-4 border-t border-line pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Emails for claims</p>
            <ul className="mt-2 space-y-1.5 text-sm">
              <li className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-paper">{emailList?.primary || data.account.email}</span>
                <span className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-lime">
                  Registration · claimable
                </span>
              </li>
              {(emailList?.additional || []).map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-paper">{row.email}</span>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                      row.verified
                        ? 'border-line text-lime'
                        : 'border-line text-gold'
                    }`}
                  >
                    {row.verified ? 'Verified · claimable' : 'Unverified · not claimable yet'}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-muted underline hover:text-paper"
                    disabled={busy === `email-rm-${row.id}`}
                    onClick={async () => {
                      setBusy(`email-rm-${row.id}`);
                      setMsg('');
                      try {
                        const res = await fetch('/api/account/emails', {
                          method: 'DELETE',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ id: row.id }),
                        });
                        const body = await res.json().catch(() => ({}));
                        if (!res.ok) throw new Error(body.error || 'Could not remove email');
                        setEmailList({
                          primary: body.primary || emailList?.primary || null,
                          additional: body.additional || [],
                          claimable: body.claimable || [],
                        });
                        setMsg('Email removed.');
                      } catch (err) {
                        setMsg(err instanceof Error ? err.message : 'Could not remove email');
                      } finally {
                        setBusy('');
                      }
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy('email-add');
                setMsg('');
                try {
                  const res = await fetch('/api/account/emails', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      email: extraEmail,
                      password: extraEmailPassword,
                    }),
                  });
                  const body = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(body.error || 'Could not add email');
                  setEmailList({
                    primary: body.primary || emailList?.primary || null,
                    additional: body.additional || [],
                    claimable: body.claimable || [],
                  });
                  setExtraEmail('');
                  setExtraEmailPassword('');
                  setMsg(
                    body.note ||
                      'Email added. It must be verified before it can receive claims. Registration email already can.'
                  );
                } catch (err) {
                  setMsg(err instanceof Error ? err.message : 'Could not add email');
                } finally {
                  setBusy('');
                }
              }}
            >
              <div>
                <label className="label" htmlFor="extra-email">
                  Add email
                </label>
                <input
                  id="extra-email"
                  className="input"
                  type="email"
                  placeholder="other@email.com"
                  value={extraEmail}
                  onChange={(e) => setExtraEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="extra-email-password">
                  Password
                </label>
                <input
                  id="extra-email-password"
                  className="input"
                  type="password"
                  value={extraEmailPassword}
                  onChange={(e) => setExtraEmailPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              <div className="flex items-end">
                <button
                  type="submit"
                  className="btn btn-primary w-full py-3 font-semibold sm:w-auto sm:px-6"
                  disabled={busy === 'email-add'}
                >
                  {busy === 'email-add' ? 'Adding…' : 'Add'}
                </button>
              </div>
            </form>
            <p className="mt-2 text-xs text-muted">
              Additional emails need verification before claims match them. Registration email is
              always claimable.
            </p>
          </div>

          <form onSubmit={onUsername} className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
            <div>
              <label className="label" htmlFor="flizy-username">
                {t('account.username')}
              </label>
              <input
                id="flizy-username"
                className="input"
                placeholder="letters and numbers only"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value.replace(/[^a-zA-Z0-9@]/g, ''))}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={24}
                required
                disabled={!canChangeUsername}
              />
              <p className="mt-1.5 text-xs text-muted">{t('account.usernameHint')}</p>
              {!canChangeUsername && nextChange ? (
                <p className="mt-1.5 text-xs text-gold">
                  {t('account.usernameCooldown', { date: nextChange })}
                </p>
              ) : null}
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                className="btn btn-primary w-full py-3 font-semibold sm:w-auto sm:px-6"
                disabled={busy === 'username' || !canChangeUsername}
              >
                {busy === 'username'
                  ? t('account.usernameSaving')
                  : data.account.username
                    ? t('account.usernameUpdate')
                    : t('account.usernameSave')}
              </button>
            </div>
          </form>
        </AppSection>
      ) : null}

      {slide === 'language' ? (
        <AppSection title={t('account.language')} helper={t('account.languageHelper')}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await setAccountLocale(localeDraft);
            }}
            className="grid gap-3"
          >
            <div>
              <label className="label" htmlFor="account-locale">
                {t('account.language')}
              </label>
              <LanguageSelect
                id="account-locale"
                value={localeDraft}
                onChange={setLocaleDraft}
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary w-full py-3 font-semibold"
              disabled={busy === 'locale'}
            >
              {busy === 'locale' ? t('account.languageSaving') : t('account.languageSave')}
            </button>
          </form>
        </AppSection>
      ) : null}

      {slide === 'chat' ? (
        <AppSection
          title="Chat apps"
          helper="Link WhatsApp or Telegram with a one-time code. Unlink anytime (password). Phone claims only pay out in the chat where the number is proven."
          badge={chatLinks.length ? String(chatLinks.length) : data.link ? 'Ready' : 'Needed'}
          badgeTone={chatLinks.length || data.link ? 'lime' : 'gold'}
        >
          {chatLinks.length > 0 ? (
            <div className="mb-4 space-y-2">
              <p className="label">Linked</p>
              {chatLinks.map((row) => (
                <div
                  key={row.channel}
                  className="rounded-md border border-border bg-ink/40 px-3 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-sans text-sm text-paper">
                        {row.channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'}
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-lime">
                        {row.phone || (row.has_phone ? 'Phone on file' : 'Linked (no phone yet)')}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs"
                      disabled={busy === 'unlink-chat'}
                      onClick={() => void onUnlinkChat(row.channel)}
                    >
                      Unlink
                    </button>
                  </div>
                  {unlinkChat === row.channel ? (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs text-muted">
                        Removes this chat and its phone proof from Flizy. Pending phone claims need
                        that number proven again in chat to claim.
                      </p>
                      <input
                        type="password"
                        className="input w-full"
                        placeholder="Account password"
                        value={unlinkChatPassword}
                        autoComplete="current-password"
                        onChange={(e) => setUnlinkChatPassword(e.target.value)}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
              <p className="text-xs text-muted">
                In chat you can also send{' '}
                <span className="font-mono text-paper">flizy unlink</span> to disconnect that app.
              </p>
            </div>
          ) : (
            <p className="mb-4 text-xs text-muted">No chat app linked yet.</p>
          )}

          <button
            type="button"
            className="btn btn-primary w-full py-3.5 text-base font-semibold"
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
        </AppSection>
      ) : null}

      {slide === 'platforms' ? (
        <AppSection
          title="Platforms"
          helper="Link GitHub, Discord, or X so people can send claims to you on that platform."
          badge="GitHub"
        >
          <LinkedAccounts />
        </AppSection>
      ) : null}

      {slide === 'trusted' ? (
        <AppSection
          title="Trusted wallets"
          helper="Only these names can receive chat sends."
          badge={`${data.trusted.length}`}
        >
          <form onSubmit={onAddTrusted} className="grid gap-3">
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
        </AppSection>
      ) : null}

      {slide === 'pin' ? (
        <AppSection
          title="Unlock PIN"
          helper="For flizy lock / unlock in chat. Password also works."
          badge={data.account.has_pin ? 'Set' : 'Required'}
          badgeTone={data.account.has_pin ? 'lime' : 'gold'}
        >
          <form onSubmit={onPin} className="grid gap-3">
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
        </AppSection>
      ) : null}

      {slide === 'limits' ? (
        <AppSection
          title="Daily send limit"
          helper={`Current: ${currentLimit}`}
          badge="Policy"
        >
          <form onSubmit={onDailyLimit} className="grid gap-3">
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
        </AppSection>
      ) : null}

      {slide === 'security' ? (
        <AppSection
          title="Security"
          helper="Password is required to change trusted wallets and limits."
        >
          <p className="text-xs leading-relaxed text-muted">
            Signed in as <span className="text-paper">{data.account.email}</span>.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
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
        </AppSection>
      ) : null}
    </AppPage>
  );
}
