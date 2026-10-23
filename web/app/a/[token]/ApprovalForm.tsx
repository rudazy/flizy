'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import Link from 'next/link';

/**
 * Enter the PIN for one chat request: an unlock, a payment that needs it, or
 * an unlink. The request is shown from the server copy the bot wrote, never
 * from the URL. On success the person goes back to the chat, where the bot
 * carries on within a couple of seconds.
 *
 * An unlock names WhatsApp or Telegram in the title the bot stored. When that
 * line is the session window, 30 minutes of activity and never longer than 8
 * hours, the screen says so in the channel's words. Any other instruction is
 * shown as the server wrote it.
 */

type Loaded =
  | { status: 'loading' }
  | { status: 'open'; kind: string; title: string; lines: string[]; chatLabel: string; expiresAt: string }
  | { status: 'expired' | 'used' | 'replaced' | 'missing' | 'locked' | 'error'; message?: string }
  | { status: 'approved'; chatLabel: string };

type Channel = 'whatsapp' | 'telegram';

const CLOSED_COPY: Record<string, string> = {
  expired: 'This link expired. Nothing happened. Go back to the chat and start again.',
  used: 'This link was already used.',
  replaced: 'This request was replaced or cancelled. Nothing happened.',
  missing: 'This link is not valid. Go back to the chat and start again.',
  error: 'Something went wrong. Try again in a moment.',
};

/** The one line startUnlock stores. Anything else is shown instead of the window cards. */
const UNLOCK_WINDOW = 'Opens this chat for 30 minutes of activity, and never longer than 8 hours.';

export function ApprovalForm({ token }: { token: string }) {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  const [pin, setPin] = useState('');
  const [shown, setShown] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/approvals/${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((body) => {
        if (cancelled) return;
        if (body?.status === 'open') {
          setState({
            status: 'open',
            kind: String(body.kind || ''),
            title: String(body.title || ''),
            lines: Array.isArray(body.lines) ? body.lines.map(String) : [],
            chatLabel: String(body.chatLabel || ''),
            expiresAt: String(body.expiresAt || ''),
          });
        } else {
          setState({ status: body?.status in CLOSED_COPY ? body.status : 'missing' });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || state.status !== 'open') return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const body = await res.json().catch(() => ({}));
      setPin('');
      if (body?.status === 'approved') {
        setState({ status: 'approved', chatLabel: String(body.chatLabel || state.chatLabel) });
        return;
      }
      if (body?.status === 'locked') {
        setState({ status: 'locked', message: String(body.error || '') });
        return;
      }
      if (body?.status && body.status !== 'open') {
        setState({ status: body.status in CLOSED_COPY ? body.status : 'missing' });
        return;
      }
      setError(String(body?.error || 'That did not work. Try again.'));
    } catch {
      setError('Could not reach Flizy. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const open = state.status === 'open' ? state : null;
  const channel = open && open.kind === 'unlock' ? channelOf(open.title, open.chatLabel) : null;
  const windowCards = Boolean(channel && open && standardWindow(open.lines));

  return (
    <div className="fade-up mx-auto w-full max-w-[440px] font-sans">
      <div
        className="relative overflow-hidden rounded-[22px] border border-[#2c2a26] px-3.5 py-7 shadow-[0_24px_70px_rgba(0,0,0,0.45)] sm:px-5"
        style={cardStyle(channel)}
      >
        <Waves channel={channel} />
        <div className="relative">
          {state.status === 'loading' ? <p className="m-0 text-[14px] text-[#b7b1a8]">Loading...</p> : null}

          {open ? (
            <form onSubmit={onSubmit} className="grid gap-4">
              <div className={`grid gap-3 ${channel ? 'justify-items-center text-center' : ''}`}>
                {channel === 'whatsapp' ? <WhatsAppMark /> : null}
                {channel === 'telegram' ? <TelegramMark /> : null}
                {channel === 'whatsapp' ? (
                  <p className="m-0 text-[12px] font-semibold uppercase tracking-[0.28em] text-sun">Approve</p>
                ) : null}
                <div>
                  <h1 className="m-0 text-[22px] font-bold leading-[1.15] tracking-tight text-white min-[400px]:text-[26px] sm:text-[30px]">
                    {channel ? <GoldTitle title={open.title} word={channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} /> : open.title}
                  </h1>
                  {open.chatLabel ? <p className="m-0 mt-2 text-[15px] text-[#9a958c]">For {open.chatLabel}</p> : null}
                </div>
              </div>

              {windowCards && channel === 'telegram' ? (
                <p className="m-0 text-center text-[15px] leading-relaxed text-[#c4beb4]">
                  This will open your Telegram chat for 30 minutes of activity, and never longer than 8 hours.
                </p>
              ) : null}

              {windowCards && channel ? <WindowCards channel={channel} /> : null}

              {!windowCards && open.lines.length ? (
                <div className="grid gap-1">
                  {open.lines.map((line, i) => (
                    <p key={i} className="m-0 break-words text-[14px] leading-relaxed text-[#d9d4ca]">
                      {line}
                    </p>
                  ))}
                </div>
              ) : null}

              <div>
                <div className="mb-2 flex min-h-[44px] items-center justify-between gap-3">
                  <label htmlFor="approval-pin" className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#d9d4ca]">
                    Your PIN
                  </label>
                  <Link
                    href="/dashboard/account?s=pin"
                    prefetch={false}
                    className="text-[13px] font-medium text-sun underline decoration-sun/50 underline-offset-[3px]"
                  >
                    Forgot PIN?
                  </Link>
                </div>
                <div className="relative">
                  <input
                    id="approval-pin"
                    className={`h-[56px] w-full rounded-[12px] border border-[#e6c35c] bg-[#0c0b0a] pl-4 pr-12 text-white caret-white shadow-[0_0_0_1px_rgba(247,208,71,0.18),0_0_22px_rgba(247,208,71,0.12)] outline-none ${
                      shown ? 'text-[18px] tracking-[0.18em]' : 'text-[22px] tracking-[0.42em]'
                    }`}
                    type={shown ? 'text' : 'password'}
                    inputMode="numeric"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    maxLength={12}
                    value={pin}
                    onChange={(e) => {
                      setPin(e.target.value.replace(/\D/g, '').slice(0, 12));
                      if (error) setError('');
                    }}
                    autoFocus
                    required
                  />
                  <button
                    type="button"
                    className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-[#9a958c]"
                    aria-label={shown ? 'Hide PIN' : 'Show PIN'}
                    aria-pressed={shown}
                    onClick={() => setShown((value) => !value)}
                  >
                    <EyeMark off={!shown} />
                  </button>
                </div>
              </div>

              <div className="flex overflow-hidden rounded-[12px] border border-[#2a2a2e] bg-[#141311]">
                {channel === 'telegram' ? null : <span className="w-[3px] shrink-0 bg-sun" aria-hidden />}
                <p className="m-0 px-4 py-3.5 text-[13.5px] leading-[1.55] text-[#b7b1a8]">
                  Only ever type your PIN here, on flizy.app.
                  <br />
                  Flizy never asks for it in a chat.
                </p>
              </div>

              {error ? (
                <p role="alert" className="m-0 rounded-[10px] border border-[#6b2430] bg-[#1a0f11] px-3 py-2 text-[13px] text-[#f87171]">
                  {error}
                </p>
              ) : null}

              <button className="btn-sun h-[54px] w-full rounded-[12px] text-[16px] font-semibold" type="submit" disabled={busy || pin.length < 4}>
                {busy ? 'Checking' : 'Approve'}
              </button>
            </form>
          ) : null}

          {state.status === 'approved' ? (
            <div className="grid gap-2" role="status">
              <h1 className="m-0 text-[26px] font-bold tracking-tight text-white">Approved</h1>
              <p className="m-0 text-[15px] leading-relaxed text-[#b7b1a8]">
                Go back to {state.chatLabel || 'the chat'}. Flizy carries on there in a moment.
              </p>
            </div>
          ) : null}

          {state.status === 'locked' ? (
            <div className="grid gap-2" role="alert">
              <h1 className="m-0 text-[26px] font-bold tracking-tight text-white">Paused</h1>
              <p className="m-0 text-[15px] leading-relaxed text-[#b7b1a8]">{state.message || 'Too many wrong PINs.'}</p>
              <p className="m-0 text-[15px] leading-relaxed text-[#b7b1a8]">Nothing happened. This link no longer works.</p>
            </div>
          ) : null}

          {state.status in CLOSED_COPY ? (
            <p className="m-0 text-[15px] leading-relaxed text-[#b7b1a8]" role="status">
              {CLOSED_COPY[state.status]}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function channelOf(title: string, chatLabel: string): Channel | null {
  const blob = `${title}\n${chatLabel}`.toLowerCase();
  if (blob.includes('whatsapp')) return 'whatsapp';
  if (blob.includes('telegram')) return 'telegram';
  return null;
}

function standardWindow(lines: string[]): boolean {
  return lines.length === 1 && lines[0].trim() === UNLOCK_WINDOW;
}

function GoldTitle({ title, word }: { title: string; word: string }) {
  const at = title.indexOf(word);
  if (at < 0) return <>{title}</>;
  return (
    <>
      {title.slice(0, at)}
      <span className="text-sun">{word}</span>
      {title.slice(at + word.length)}
    </>
  );
}

function WindowCards({ channel }: { channel: Channel }) {
  const activity =
    channel === 'whatsapp' ? 'This will open your chat for 30 minutes of activity.' : 'Your chat will be open for activity.';
  const limit =
    channel === 'whatsapp' ? 'The chat will automatically lock after 8 hours.' : 'Auto-locks after 8 hours for your security.';
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-[16px] border border-[#2a2a2e] bg-[#101011]">
      <div className="min-w-0 border-r border-[#2a2a2e] px-3 py-3.5 sm:px-3.5">
        <p className="m-0 text-[12.5px] text-[#9a958c]">Chat unlock duration</p>
        <p className="m-0 mt-1.5 text-[18px] font-semibold leading-none text-white sm:text-[20px]">30 minutes</p>
        <p className="m-0 mt-1.5 text-[12.5px] leading-snug text-[#8d867c]">{activity}</p>
      </div>
      <div className="min-w-0 px-3 py-3.5 sm:px-3.5">
        <p className="m-0 text-[12.5px] text-[#9a958c]">Security limit</p>
        <p className="m-0 mt-1.5 text-[18px] font-semibold leading-none text-white sm:text-[20px]">Max 8 hours</p>
        <p className="m-0 mt-1.5 text-[12.5px] leading-snug text-[#8d867c]">{limit}</p>
      </div>
    </div>
  );
}

function cardStyle(channel: Channel | null): CSSProperties {
  if (channel === 'whatsapp') {
    return {
      background:
        'radial-gradient(78% 34% at 50% 0%, rgba(28, 92, 52, 0.55) 0%, rgba(12, 13, 12, 0) 64%), radial-gradient(42% 20% at 16% 10%, rgba(18, 64, 36, 0.45) 0%, transparent 72%), radial-gradient(40% 18% at 86% 8%, rgba(14, 52, 30, 0.4) 0%, transparent 70%), #0c0d0c',
    };
  }
  return {
    background:
      'radial-gradient(88% 34% at 50% 0%, rgba(110, 82, 18, 0.5) 0%, rgba(12, 11, 10, 0) 64%), radial-gradient(46% 18% at 10% 8%, rgba(72, 52, 14, 0.34) 0%, transparent 72%), radial-gradient(42% 16% at 90% 6%, rgba(90, 64, 14, 0.3) 0%, transparent 70%), #0c0b0a',
  };
}

function Waves({ channel }: { channel: Channel | null }) {
  const soft = channel === 'whatsapp' ? 'rgba(52, 150, 86, 0.22)' : 'rgba(214, 170, 54, 0.2)';
  const deep = channel === 'whatsapp' ? 'rgba(16, 62, 36, 0.55)' : 'rgba(92, 66, 16, 0.4)';
  return (
    <svg className="pointer-events-none absolute inset-x-0 top-0 h-[200px] w-full" viewBox="0 0 440 200" preserveAspectRatio="xMidYMin slice" aria-hidden>
      <path d="M-40 78c78-52 140 34 214 2s156-64 270 12" fill="none" stroke={deep} strokeWidth="36" strokeLinecap="round" />
      <path d="M-24 40c86-44 148 26 228-8s148-44 246 16" fill="none" stroke={soft} strokeWidth="14" strokeLinecap="round" />
      <path d="M20 108c64-28 118 18 186-6s124-34 210 12" fill="none" stroke={soft} strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}

function WhatsAppMark() {
  return (
    <div className="relative h-[124px] w-[124px]" aria-hidden>
      <span className="absolute inset-0 rounded-full border border-[#3d382c]" />
      <span className="absolute inset-[11px] rounded-full border border-[#e6c35c]" />
      <span className="absolute inset-[20px] flex items-center justify-center rounded-full bg-[#25D366] shadow-[0_0_28px_rgba(37,211,102,0.38)]">
        <svg viewBox="0 0 24 24" className="h-9 w-9 -rotate-[24deg]" fill="#fff">
          <path d="M6.7 4.1c.6-.6 1.5-.7 2.2-.2l1.5.8c.6.3.9.9.8 1.5l-.5 2.1c-.1.5-.4.9-.8 1.1l-.9.5a9.2 9.2 0 0 0 4.6 4.6l.5-.9c.2-.4.6-.7 1.1-.8l2.1-.5c.6-.1 1.2.2 1.5.8l.8 1.5c.5.7.4 1.6-.2 2.2l-1.3 1.3c-.6.6-1.4.8-2.2.6-3.1-.6-6-2.4-8.2-4.6S4.4 9.1 3.8 6c-.2-.8 0-1.6.6-2.2l2.3-2.3z" />
        </svg>
      </span>
    </div>
  );
}

function TelegramMark() {
  return (
    <div className="relative h-[128px] w-[128px]" aria-hidden>
      <svg viewBox="0 0 128 128" className="absolute inset-0">
        <circle cx="64" cy="64" r="56" fill="none" stroke="rgba(247,208,71,0.14)" strokeWidth="1.5" />
        <circle
          cx="64"
          cy="64"
          r="56"
          fill="none"
          stroke="#f7d047"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="254 98"
          transform="rotate(140 64 64)"
        />
      </svg>
      <span className="absolute left-1/2 top-1/2 flex h-[76px] w-[76px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[#2AABEE] shadow-[0_0_26px_rgba(42,171,238,0.32)]">
        <svg viewBox="0 0 24 24" className="ml-0.5 h-9 w-9" aria-hidden>
          <path
            fill="#fff"
            d="M21.4 3.6 2.6 10.7c-.9.3-.9 1.6.1 1.9l4.8 1.5 1.8 5.6c.3.9 1.4 1.1 2 .4l2.6-2.4 4.7 3.5c.7.5 1.6.1 1.8-.7l3.2-15.1c.3-1-.7-1.9-1.7-1.5zM8.8 13.5l9.2-6.1-7.4 7.1-.2 3.3-1.6-4.3z"
          />
        </svg>
      </span>
    </div>
  );
}

function EyeMark({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" aria-hidden>
      <path d="M2.8 12S6.2 6.6 12 6.6 21.2 12 21.2 12 17.8 17.4 12 17.4 2.8 12 2.8 12Z" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.6" />
      {off ? <path d="M5 19.2 19 4.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : null}
    </svg>
  );
}
