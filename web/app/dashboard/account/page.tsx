'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AccountClosureSheet } from '../../../components/AccountClosureSheet';
import { AccountProfile } from '../../../components/AccountProfile';
import { AppTopBar } from '../../../components/AppTopBar';
import {
  AppPage,
  AppSection,
  AppSlideNav,
  useSlide,
} from '../../../components/AppSection';
import { useComingSoon } from '../../../components/ComingSoon';
import { useDashboard } from '../../../components/DashboardProvider';
import { useLocale } from '../../../components/LocaleProvider';
import { LinkedAccounts } from '../../../components/LinkedAccounts';
import { PayIdentity } from '../../../components/PayIdentity';
import { CountryPanel, LanguagePanel } from '../../../components/AccountPrefs';
import { ChatAppsPanel, TrustedPanel } from '../../../components/AccountConnections';
import { LimitsPanel, PinPanel, SecurityPanel } from '../../../components/AccountSecurity';
import { AccountProjects } from '../../../components/AccountProjects';
import type { LocaleCode } from '../../../lib/locale';
import { SITE_PHONE_COUNTRIES, countryByIso, countryFlag } from '../../../lib/phoneFormat';
import {
  clearAwaitingChatLink,
  markAwaitingChatLink,
  peekAwaitingChatLink,
  type ChatLinkChannel,
} from '../../../lib/chatLinkAwait.ts';

const SLIDES = [
  'profile',
  'projects',
  'pay',
  'language',
  'country',
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
  const router = useRouter();
  const { t, locale } = useLocale();
  const [comingSoon, comingSoonNote] = useComingSoon();
  const {
    data,
    busy,
    msg,
    setMsg,
    setBusy,
    load,
    generateLink,
    addTrusted,
    removeTrusted,
    setUnlockPin,
    setDailyLimit,
    setUsername,
    setAccountLocale,
    setDefaultCallingCode,
  } = useDashboard();
  const [localeDraft, setLocaleDraft] = useState<LocaleCode>(locale);
  const [countryIso, setCountryIso] = useState('');

  const [addr, setAddr] = useState('');
  const [label, setLabel] = useState('');
  const [confirmAdd, setConfirmAdd] = useState(false);
  // The last save or delete in a trusted-wallet sheet was refused; msg then holds why.
  const [sheetRefused, setSheetRefused] = useState(false);
  /** Ticket code from a chat-started add, passed back so the add can spend it. */
  const [ticket, setTicket] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
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
  const [profileEditor, setProfileEditor] = useState<'email' | 'username' | 'name' | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [awaitingChat, setAwaitingChat] = useState<ChatLinkChannel | null>(null);
  const [closureOpen, setClosureOpen] = useState(false);

  // Account opens on the profile. Every other slide stays on the chip row.
  const defaultSlide = useMemo((): SlideId => {
    if (search.get('github')) return 'platforms';
    return 'profile';
  }, [search]);

  const [slide, setSlide] = useSlide(SLIDES, defaultSlide);

  useEffect(() => {
    if (data?.account?.username) {
      setUsernameInput(data.account.username);
    }
  }, [data?.account?.username]);

  useEffect(() => {
    setNameDraft(data?.account?.display_name || '');
  }, [data?.account?.display_name]);

  // The saved country as one ISO code, or '' when none is saved or the code is shared.
  const savedCountryIso = useMemo(() => {
    const savedIso = String(data?.account?.default_country_iso || '').toUpperCase();
    if (savedIso && countryByIso(savedIso)) return savedIso;
    const dial = String(data?.account?.default_calling_code || '');
    const matches = SITE_PHONE_COUNTRIES.filter((country) => country.dial === dial);
    return matches.length === 1 ? matches[0].iso : '';
  }, [data?.account?.default_calling_code, data?.account?.default_country_iso]);

  useEffect(() => {
    setCountryIso(savedCountryIso);
  }, [savedCountryIso]);

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

  useEffect(() => {
    setAwaitingChat(peekAwaitingChatLink());
  }, []);

  // OAuth error/status lands with ?github= — always show Platforms slide.
  // Chat link return (?telegram=linked / ?whatsapp=linked) opens Chat.
  useEffect(() => {
    if (search.get('github')) setSlide('platforms');
    const tg = search.get('telegram');
    const wa = search.get('whatsapp');
    if (tg === 'linked' || wa === 'linked') {
      setSlide('chat');
      clearAwaitingChatLink();
      setAwaitingChat(null);
      const params = new URLSearchParams(search.toString());
      params.delete('telegram');
      params.delete('whatsapp');
      const rest = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    }
  }, [search, setSlide, setMsg]);

  // After they tap Link Telegram/WhatsApp, poll until that chat appears.
  useEffect(() => {
    if (!awaitingChat) return;
    setSlide('chat');
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/identity', { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json().catch(() => ({}));
        const rows = Array.isArray(body.identities) ? body.identities : [];
        const chats = rows.filter(
          (r: { channel: string }) => r.channel === 'whatsapp' || r.channel === 'telegram'
        );
        if (cancelled) return;
        setChatLinks(chats);
        if (chats.some((r: { channel: string }) => r.channel === awaitingChat)) {
          clearAwaitingChatLink();
          setAwaitingChat(null);
        }
      } catch {
        /* next tick */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [awaitingChat, setMsg, setSlide]);

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

  async function closeAccount(
    body: { action: 'deactivate' } | { action: 'delete'; password: string }
  ): Promise<string | null> {
    try {
      const res = await fetch('/api/account/closure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        return typeof json.error === 'string' ? json.error : 'Could not close the account.';
      }
      return null;
    } catch {
      return 'Could not close the account.';
    }
  }

  /**
   * An add begun in chat arrives as ?add=CODE.
   *
   * The ticket carries the address across so it does not have to be retyped,
   * which matters most for "save this merchant": the payer has never seen that
   * 0x. It fills the form and nothing more. The password asked for in the
   * save sheet is still what authorises the add.
   */
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('add');
    if (!code) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/trusted/ticket?code=${encodeURIComponent(code)}`);
        const body = await res.json();
        if (cancelled) return;
        if (body?.ok) {
          setTicket(code);
          setAddr(String(body.address || ''));
          if (body.label) setLabel(String(body.label));
          setSlide('trusted');
        } else if (body?.error) {
          setMsg(String(body.error));
        }
      } catch {
        /* a dead link is not worth an error banner; the form still works */
      }
    })();
    return () => {
      cancelled = true;
    };
    // Once, on mount. The code is consumed by the add, not by reading it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Open the save sheet. An older notice is cleared so the sheet only ever shows this save's error. */
  function onAddTrusted() {
    setSheetRefused(false);
    setConfirmAdd(true);
  }

  async function onConfirmAdd(password: string) {
    setSheetRefused(false);
    const ok = await addTrusted({ address: addr, label, password, ticket });
    if (ok) {
      setConfirmAdd(false);
      setAddr('');
      setLabel('');
      setTicket('');
    } else {
      setSheetRefused(true);
    }
  }

  function onRemove(address: string) {
    setSheetRefused(false);
    setRemoving(address);
  }

  async function onConfirmRemove(password: string) {
    if (!removing) return;
    setSheetRefused(false);
    const ok = await removeTrusted(removing, password);
    if (ok) setRemoving(null);
    else setSheetRefused(true);
  }

  /**
   * Change the password. Resolves to why it was refused, or null when it
   * changed. The server signs every other device out and renews this one; if
   * it could not renew this one, the next page load asks for a login.
   */
  async function onChangePassword(currentPassword: string, newPassword: string): Promise<string | null> {
    setBusy('password');
    setMsg('');
    try {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return typeof json.error === 'string' ? json.error : 'Could not change the password.';
      if (json.stillSignedIn === false) {
        window.location.href = '/login';
        return null;
      }
      // Silent on success. Other devices still signed in is a warning to act on, so it is said.
      if (json.signedOutElsewhere === false) {
        setMsg('Password changed, but other devices could not be signed out: sign out on them yourself.');
      }
      return null;
    } catch {
      return 'Could not change the password. Try again.';
    } finally {
      setBusy('');
    }
  }

  function onPin(pin: string, password: string) {
    return setUnlockPin(pin, password);
  }

  async function onUsername(e: React.FormEvent) {
    e.preventDefault();
    const ok = await setUsername(usernameInput);
    if (ok) setProfileEditor(null);
  }

  async function onDisplayName(e: React.FormEvent) {
    e.preventDefault();
    if (!data?.account?.username) {
      setMsg('Set a username first.');
      return;
    }
    setBusy('display-name');
    setMsg('');
    try {
      const res = await fetch('/api/account/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: data.account.username,
          displayName: nameDraft.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not save the display name.');
      setProfileEditor(null);
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not save the display name.');
    } finally {
      setBusy('');
    }
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
    // A development build has no mail transport, so the server hands the code
    // back instead of sending it. Every other caller of this pattern dropped it
    // and left a code box nothing could fill; say it out loud here instead.
    if (body.devCode) setMsg(`Local build, no mail configured. Your code is ${body.devCode}`);
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

  return (
    <AppPage>
      <AppTopBar title="Account" />
      {comingSoonNote}
      <AccountClosureSheet
        open={closureOpen}
        onClose={() => setClosureOpen(false)}
        onDeactivate={() => closeAccount({ action: 'deactivate' })}
        onDelete={(password) => closeAccount({ action: 'delete', password })}
      />

      <AppSlideNav
        items={[
          {
            id: 'profile',
            label: t('account.profile'),
            badge: data.account.username ? `@${data.account.username}` : undefined,
          },
          { id: 'projects', label: 'Projects' },
          { id: 'pay', label: 'Pay me', badge: data.pay?.username ? `@${data.pay.username}` : undefined },
          { id: 'language', label: t('account.language') },
          {
            id: 'country',
            label: 'Country',
            badge: data.account.default_country_iso
              ? `${countryFlag(data.account.default_country_iso)} +${
                  countryByIso(data.account.default_country_iso)?.dial || data.account.default_calling_code || ''
                }`
              : data.account.default_calling_code
                ? `+${data.account.default_calling_code}`
                : undefined,
          },
          { id: 'chat', label: 'Chat', badge: data.link ? undefined : '!' },
          { id: 'platforms', label: 'Platforms' },
          { id: 'trusted', label: 'Trusted', badge: String(data.trusted.length) },
          { id: 'pin', label: 'PIN', badge: data.account.has_pin ? undefined : '!' },
          { id: 'limits', label: 'Limits' },
          { id: 'security', label: 'Security' },
        ]}
        activeId={slide}
        onSelect={setSlide}
      />

      {slide === 'profile' ? (
        <div className="w-full">
        <AccountProfile
          username={data.account.username || ''}
          displayName={data.account.display_name || ''}
          email={emailList?.primary || data.account.email || ''}
          address={data.account.agent_wallet_address || ''}
          invites={data.invite?.attributed ?? 0}
          credits={data.invite?.credits ?? 0}
          onEmail={() => setProfileEditor((cur) => (cur === 'email' ? null : 'email'))}
          onUsername={() => setProfileEditor((cur) => (cur === 'username' ? null : 'username'))}
          onName={() => setProfileEditor((cur) => (cur === 'name' ? null : 'name'))}
          onWallet={() => router.push('/dashboard/wallet')}
          onSecurity={() => setSlide('security')}
          onSoon={comingSoon}
          onOpen={setSlide}
          onDelete={() => setClosureOpen(true)}
          onSignOut={() => void onSignOut()}
          emailPanel={
            profileEditor === 'email' ? (
          <div className="space-y-3">
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
                    // Same reason as requestEmailCode: on a local build the code
                    // comes back here rather than by email.
                    if (body.devCode) {
                      setMsg(`Local build, no mail configured. Your code is ${body.devCode}`);
                    }
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
            ) : null
          }
          usernamePanel={
            profileEditor === 'username' ? (
              <div className="space-y-3">
                {nextChange ? (
                  <p className="text-xs text-gold">
                    {t('account.usernameCooldown', { date: nextChange })}
                  </p>
                ) : (
                  <p className="text-xs text-muted">{t('account.usernameHint')}</p>
                )}
                {canChangeUsername ? (
                  <form onSubmit={onUsername} className="grid gap-2">
                    <input
                      id="flizy-username"
                      className="input"
                      placeholder="letters and numbers only"
                      value={usernameInput}
                      onChange={(e) =>
                        setUsernameInput(e.target.value.replace(/[^a-zA-Z0-9@]/g, ''))
                      }
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={24}
                      required
                    />
                    <button
                      type="submit"
                      className="btn btn-primary w-full py-3 font-semibold"
                      disabled={busy === 'username'}
                    >
                      {busy === 'username'
                        ? t('account.usernameSaving')
                        : data.account.username
                          ? t('account.usernameUpdate')
                          : t('account.usernameSave')}
                    </button>
                  </form>
                ) : null}
              </div>
            ) : null
          }
          namePanel={
            profileEditor === 'name' ? (
              <form onSubmit={onDisplayName} className="grid gap-2">
                <input
                  className="input"
                  placeholder="Display name"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value.slice(0, 64))}
                  maxLength={64}
                />
                <button
                  type="submit"
                  className="btn btn-primary w-full py-3 font-semibold"
                  disabled={busy === 'display-name'}
                >
                  {busy === 'display-name' ? 'Saving' : 'Save display name'}
                </button>
              </form>
            ) : null
          }
        />
        </div>
      ) : null}

      {slide === 'projects' ? <AccountProjects /> : null}

      {slide === 'pay' ? (
        data.pay ? (
          <PayIdentity url={data.pay.url} qrUrl={data.pay.qrUrl} code={data.pay.code} username={data.pay.username} />
        ) : (
          <AppSection title="Pay me" helper="Print the QR with your Flizy number under it. A scan or your @username opens Flizy pay.">
            <p className="text-sm text-muted">Set a username on Profile first. Your Flizy number is issued then.</p>
          </AppSection>
        )
      ) : null}

      {slide === 'country' ? (
        <CountryPanel
          value={countryIso}
          saved={savedCountryIso}
          onChange={setCountryIso}
          onSave={() => void setDefaultCallingCode(countryIso)}
          saving={busy === 'calling-code'}
        />
      ) : null}

      {slide === 'language' ? (
        <LanguagePanel
          eyebrow={t('account.preferences')}
          title={t('account.language')}
          text={t('account.languageHelper')}
          saved={locale}
          value={localeDraft}
          onChange={setLocaleDraft}
          onSave={() => void setAccountLocale(localeDraft)}
          saving={busy === 'locale'}
          saveLabel={t('account.languageSave')}
          savingLabel={t('account.languageSaving')}
          currentLabel={t('account.languageCurrent')}
        />
      ) : null}

      {slide === 'chat' ? (
        <ChatAppsPanel
          links={chatLinks}
          code={data.link ?? null}
          generating={busy === 'link'}
          onGenerate={() => void generateLink()}
          unlinking={unlinkChat}
          password={unlinkChatPassword}
          onPassword={setUnlinkChatPassword}
          onToggleUnlink={toggleUnlinkChat}
          onConfirmUnlink={(channel) => void onUnlinkChat(channel)}
          unlinkBusy={busy === 'unlink-chat'}
          awaiting={awaitingChat}
          onStart={(channel) => {
            markAwaitingChatLink(channel);
            setAwaitingChat(channel);
          }}
        />
      ) : null}

      {slide === 'platforms' ? <LinkedAccounts /> : null}

      {slide === 'trusted' ? (
        <TrustedPanel
          fromChat={Boolean(ticket)}
          name={label}
          onName={setLabel}
          address={addr}
          onAddress={setAddr}
          onSave={onAddTrusted}
          confirmingSave={confirmAdd}
          onCancelSave={() => setConfirmAdd(false)}
          onConfirmSave={(pw) => void onConfirmAdd(pw)}
          saving={busy === 'trusted'}
          saveError={confirmAdd && sheetRefused ? msg : ''}
          saved={data.trusted}
          removing={removing}
          onRemove={onRemove}
          onCancelRemove={() => setRemoving(null)}
          onConfirmRemove={(pw) => void onConfirmRemove(pw)}
          removeBusy={busy === 'remove'}
          removeError={removing && sheetRefused ? msg : ''}
        />
      ) : null}

      {slide === 'pin' ? (
        <PinPanel hasPin={Boolean(data.account.has_pin)} onSave={onPin} busy={busy === 'pin'} lastError={msg} />
      ) : null}

      {slide === 'limits' ? (
        <LimitsPanel current={currentLimit} onSave={setDailyLimit} busy={busy === 'limit'} lastError={msg} />
      ) : null}

      {slide === 'security' ? (
        <SecurityPanel
          email={data.account.email ?? null}
          emailVerified={Boolean(data.account.email_verified)}
          onChangeEmail={() => {
            setSlide('profile');
            setProfileEditor('email');
          }}
          onChangePassword={onChangePassword}
          changingPassword={busy === 'password'}
          onSignOut={() => void onSignOut()}
          signingOut={busy === 'logout'}
        />
      ) : null}
    </AppPage>
  );
}
