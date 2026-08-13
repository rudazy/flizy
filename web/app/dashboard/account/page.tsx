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
    primaryVerified?: boolean;
    additional: Array<{ id: string; email: string; verified: boolean }>;
    claimable: string[];
  } | null>(null);
  const [extraEmail, setExtraEmail] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyTarget, setVerifyTarget] = useState<'primary' | string>('primary');
  const [addEmailOpen, setAddEmailOpen] = useState(false);
  const [addEmailStep, setAddEmailStep] = useState<'email' | 'code'>('email');

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
            primaryVerified: Boolean(body.primaryVerified ?? data?.account?.email_verified),
            additional: Array.isArray(body.additional) ? body.additional : [],
            claimable: Array.isArray(body.claimable) ? body.claimable : [],
          });
        }
      } catch {
        if (!cancelled && data?.account?.email) {
          setEmailList({
            primary: data.account.email,
            primaryVerified: Boolean(data.account.email_verified),
            additional: [],
            claimable: data.account.email_verified ? [data.account.email] : [],
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

  async function refreshEmails() {
    const listRes = await fetch('/api/account/emails', { cache: 'no-store' });
    const listBody = await listRes.json().catch(() => ({}));
    if (!listRes.ok) return;
    setEmailList({
      primary: listBody.primary || emailList?.primary || null,
      primaryVerified: Boolean(listBody.primaryVerified),
      additional: listBody.additional || [],
      claimable: listBody.claimable || [],
    });
  }

  async function requestEmailCode(purpose: 'primary' | 'secondary', email?: string) {
    const res = await fetch('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        purpose === 'primary' ? { purpose: 'primary' } : { purpose: 'secondary', email }
      ),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not send code');
    return body;
  }

  async function verifyEmailCode(purpose: 'primary' | 'secondary', email?: string) {
    const res = await fetch('/api/auth/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        purpose,
        code: verifyCode,
        email: purpose === 'secondary' ? email : undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not verify');
    return body;
  }

  /** Open the password prompt for a chat row, or close it if already open. */
  function toggleUnlinkChat(channel: string) {
    if (unlinkChat === channel) {
      setUnlinkChat(null);
      setUnlinkChatPassword('');
      setMsg('');
      return;
    }
    // Clear on every open so a password typed for WhatsApp cannot carry over
    // and authorise unlinking Telegram in one click.
    setUnlinkChat(channel);
    setUnlinkChatPassword('');
    setMsg('');
  }

  async function onUnlinkChat(channel: string) {
    if (!unlinkChatPassword) {
      setMsg('Enter your account password to confirm.');
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
          {data.account.display_name ? (
            <p className="mt-1 text-xs text-muted">{data.account.display_name}</p>
          ) : null}

          <div className="mt-4 border-t border-line pt-4 space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Emails</p>
            <ul className="space-y-2 text-sm">
              <li className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-paper">
                  {emailList?.primary || data.account.email}
                </span>
                {!(emailList?.primaryVerified || data.account.email_verified) ? (
                  <button
                    type="button"
                    className="btn btn-ghost text-sm"
                    disabled={busy === 'email-send-primary'}
                    onClick={async () => {
                      setBusy('email-send-primary');
                      setMsg('');
                      setVerifyTarget('primary');
                      try {
                        await requestEmailCode('primary');
                        setAddEmailOpen(false);
                      } catch (err) {
                        setMsg(err instanceof Error ? err.message : 'Could not send code');
                      } finally {
                        setBusy('');
                      }
                    }}
                  >
                    {busy === 'email-send-primary' ? 'Sending…' : 'Request code'}
                  </button>
                ) : null}
              </li>
              {(emailList?.additional || []).map((row) => (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-paper">{row.email}</span>
                  {row.verified ? (
                    <button
                      type="button"
                      className="btn btn-ghost text-sm"
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
                          if (!res.ok) throw new Error(body.error || 'Could not unlink email');
                          setEmailList({
                            primary: body.primary || emailList?.primary || null,
                            primaryVerified: Boolean(body.primaryVerified),
                            additional: body.additional || [],
                            claimable: body.claimable || [],
                          });
                          setMsg('Email unlinked.');
                        } catch (err) {
                          setMsg(err instanceof Error ? err.message : 'Could not unlink email');
                        } finally {
                          setBusy('');
                        }
                      }}
                    >
                      Unlink
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost text-sm"
                      disabled={busy === `email-send-${row.id}`}
                      onClick={async () => {
                        setBusy(`email-send-${row.id}`);
                        setMsg('');
                        setVerifyTarget(row.email);
                        setAddEmailOpen(true);
                        setAddEmailStep('code');
                        setExtraEmail(row.email);
                        try {
                          await requestEmailCode('secondary', row.email);
                        } catch (err) {
                          setMsg(err instanceof Error ? err.message : 'Could not send code');
                        } finally {
                          setBusy('');
                        }
                      }}
                    >
                      Request code
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {verifyTarget === 'primary' &&
            !(emailList?.primaryVerified || data.account.email_verified) ? (
              <form
                className="grid gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy('email-verify');
                  setMsg('');
                  try {
                    await verifyEmailCode('primary');
                    setVerifyCode('');
                    await refreshEmails();
                    setMsg('Added successfully');
                  } catch (err) {
                    setMsg(err instanceof Error ? err.message : 'Could not verify');
                  } finally {
                    setBusy('');
                  }
                }}
              >
                <input
                  className="input font-mono"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6-digit code"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  required
                />
                <button
                  type="submit"
                  className="btn btn-primary w-full py-2 text-sm font-semibold"
                  disabled={busy === 'email-verify' || verifyCode.length !== 6}
                >
                  {busy === 'email-verify' ? 'Checking…' : 'Verify'}
                </button>
              </form>
            ) : null}

            {!addEmailOpen ? (
              <button
                type="button"
                className="btn btn-ghost w-full text-sm"
                onClick={() => {
                  setAddEmailOpen(true);
                  setAddEmailStep('email');
                  setExtraEmail('');
                  setVerifyCode('');
                  setMsg('');
                }}
              >
                Add email
              </button>
            ) : addEmailStep === 'email' ? (
              <form
                className="grid gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy('email-add');
                  setMsg('');
                  try {
                    const res = await fetch('/api/account/emails', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ email: extraEmail }),
                    });
                    const body = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(body.error || 'Could not add email');
                    await refreshEmails();
                    setVerifyTarget(String(extraEmail || '').trim().toLowerCase());
                    setAddEmailStep('code');
                    setVerifyCode('');
                  } catch (err) {
                    setMsg(err instanceof Error ? err.message : 'Could not add email');
                  } finally {
                    setBusy('');
                  }
                }}
              >
                <input
                  className="input"
                  type="email"
                  placeholder="email@example.com"
                  value={extraEmail}
                  onChange={(e) => setExtraEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
                <button
                  type="submit"
                  className="btn btn-primary w-full py-2 text-sm font-semibold"
                  disabled={busy === 'email-add'}
                >
                  {busy === 'email-add' ? 'Sending…' : 'Request code'}
                </button>
              </form>
            ) : (
              <form
                className="grid gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy('email-verify');
                  setMsg('');
                  try {
                    await verifyEmailCode('secondary', verifyTarget === 'primary' ? extraEmail : verifyTarget);
                    setVerifyCode('');
                    setAddEmailOpen(false);
                    setAddEmailStep('email');
                    setExtraEmail('');
                    await refreshEmails();
                    setMsg('Added successfully');
                  } catch (err) {
                    setMsg(err instanceof Error ? err.message : 'Could not verify');
                  } finally {
                    setBusy('');
                  }
                }}
              >
                <input
                  className="input font-mono"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6-digit code"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  required
                />
                <button
                  type="submit"
                  className="btn btn-primary w-full py-2 text-sm font-semibold"
                  disabled={busy === 'email-verify' || verifyCode.length !== 6}
                >
                  {busy === 'email-verify' ? 'Checking…' : 'Verify'}
                </button>
              </form>
            )}
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
                      onClick={() => toggleUnlinkChat(row.channel)}
                    >
                      {unlinkChat === row.channel ? 'Cancel' : 'Unlink'}
                    </button>
                  </div>
                  {unlinkChat === row.channel ? (
                    // A form, not a bare input: without one there is no submit
                    // control and Enter does nothing, so the prompt asks for a
                    // password and then gives no way to send it.
                    <form
                      className="mt-3 space-y-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void onUnlinkChat(row.channel);
                      }}
                    >
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
                        autoFocus
                        onChange={(e) => setUnlinkChatPassword(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          className="btn btn-primary px-3 py-1.5 text-xs"
                          disabled={busy === 'unlink-chat' || !unlinkChatPassword}
                        >
                          {busy === 'unlink-chat'
                            ? 'Unlinking...'
                            : `Confirm unlink ${row.channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'}`}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost px-3 py-1.5 text-xs"
                          disabled={busy === 'unlink-chat'}
                          onClick={() => toggleUnlinkChat(row.channel)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
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
