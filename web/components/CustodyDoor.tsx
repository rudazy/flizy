'use client';

import Link from 'next/link';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { PrivyProvider, usePrivy, type PrivyClientConfig } from '@privy-io/react-auth';
import { defineChain } from 'viem';
import {
  CUSTODY_DOOR_CHAIN,
  CUSTODY_DOOR_COPY,
  custodyDoorAppId,
  custodyDoorIsGuest,
  passwordLoginHref,
} from '../lib/custodyDoor';

/**
 * Browser login. Email and password, on the separate form, is the public path.
 * Passkey, Privy email, Google, and guest stay on this screen and answer
 * Coming soon until they are public. Nothing here connects an external wallet,
 * opens a Flizy session, sends a transaction, or calls a server wallet.
 */

const giwaSepolia = defineChain({
  id: CUSTODY_DOOR_CHAIN.id,
  name: CUSTODY_DOOR_CHAIN.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [CUSTODY_DOOR_CHAIN.rpcUrl] } },
  blockExplorers: {
    default: { name: 'GIWA Explorer', url: CUSTODY_DOOR_CHAIN.explorerUrl },
  },
});

const privyConfig: PrivyClientConfig = {
  loginMethods: ['passkey', 'email', 'google'],
  defaultChain: giwaSepolia,
  supportedChains: [giwaSepolia],
  embeddedWallets: {
    ethereum: { createOnLogin: 'users-without-wallets' },
  },
  appearance: {
    theme: 'dark',
    accentColor: '#f7d043',
    landingHeader: CUSTODY_DOOR_COPY.modalHeader,
    loginMessage: CUSTODY_DOOR_COPY.modalMessage,
  },
  legal: {
    termsAndConditionsUrl: 'https://flizy.app/terms',
    privacyPolicyUrl: 'https://flizy.app/privacy',
  },
};

function StrokeIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

function ShieldIcon() {
  return (
    <StrokeIcon>
      <path
        d="M12 3.5 19 6.2v5.3c0 4.2-2.8 7.2-7 8.9-4.2-1.7-7-4.7-7-8.9V6.2L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </StrokeIcon>
  );
}

function ChatIcon() {
  return (
    <StrokeIcon>
      <path
        d="M6 16.5 4.5 19.5l3.4-1.2A8.2 8.2 0 1 0 6 16.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </StrokeIcon>
  );
}

function KeyIcon() {
  return (
    <StrokeIcon>
      <circle cx="9" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 12h8.2M16.6 12v2.4M19.2 12v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </StrokeIcon>
  );
}

function FingerprintIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      <path d="M8.2 13.2c.3 3.2 1.2 5.6 1.2 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12 10.2a3.2 3.2 0 0 0-1.2 6.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M7.2 9.4A6.2 6.2 0 0 1 18 13c0 2.2-.5 4.2-1.1 5.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5 12.2A8.2 8.2 0 0 1 19.4 9.6c.7 1.6 1.1 3.5 1.1 5.4 0 2-.4 3.8-.9 5.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function GoogleColorMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.9z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.3 26.7 36 24 36c-5.3 0-9.8-3.4-11.4-8.1l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#c8c2b8"
        d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.3 4.1-4.2 5.4l6.3 5.3C40.3 35.8 44 31 44 24c0-1.3-.1-2.7-.4-3.9z"
      />
    </svg>
  );
}

function BoltIcon() {
  return (
    <StrokeIcon>
      <path
        d="M13 3.5 6.5 13H12l-1 7.5 6.5-9.5H12l1-7.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </StrokeIcon>
  );
}

function MailIcon() {
  return (
    <StrokeIcon>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="m4.5 7 7.5 6L19.5 7" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </StrokeIcon>
  );
}

function PersonIcon() {
  return (
    <StrokeIcon>
      <circle cx="12" cy="8.5" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M6.5 18.5c.8-2.8 2.8-4.2 5.5-4.2s4.7 1.4 5.5 4.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </StrokeIcon>
  );
}

function PasskeyIcon() {
  return (
    <StrokeIcon>
      <circle cx="9" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M5.2 17.2c.6-2.2 2-3.3 3.8-3.3 1.9 0 3.2 1.1 3.8 3.3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="16.2" cy="10" r="1.7" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16.2 11.7v3.2M15 13.4h2.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </StrokeIcon>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <path
        fill="#f7d047"
        d="M21.6 12.23c0-.72-.06-1.41-.18-2.08H12v3.94h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.23c1.89-1.74 2.99-4.31 2.99-7.38Z"
      />
      <path
        fill="#e0b84a"
        d="M12 22c2.7 0 4.96-.9 6.62-2.42l-3.23-2.5c-.9.6-2.04.96-3.39.96-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#c4893f"
        d="M6.4 13.92a6.02 6.02 0 0 1 0-3.84V7.49H3.06a10 10 0 0 0 0 9.02l3.34-2.59Z"
      />
      <path
        fill="#f7d047"
        d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.96 9.96 0 0 0 3.06 7.49L6.4 10.1c.79-2.36 3-4.12 5.6-4.12Z"
      />
    </svg>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-muted" fill="none" aria-hidden>
      <path
        d="m7.5 4.5 5 5.5-5 5.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconBox({ children, mark = false }: { children: ReactNode; mark?: boolean }) {
  return (
    <span
      className={
        mark
          ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-sun/50 bg-sun/10 text-sun'
          : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-white/10 bg-[#1a1b20] text-sun'
      }
    >
      {children}
    </span>
  );
}

function DoorArt() {
  const id = useId().replace(/:/g, '');
  const planet = `${id}-planet`;
  const coin = `${id}-coin`;
  const glow = `${id}-glow`;
  return (
    <svg viewBox="0 0 280 250" className="h-full w-full" aria-hidden>
      <defs>
        <radialGradient id={planet} cx="50%" cy="45%" r="50%">
          <stop offset="0%" stopColor="#ffe58a" stopOpacity="0.95" />
          <stop offset="42%" stopColor="#c4893f" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#f7d047" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={coin} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffe9a0" />
          <stop offset="48%" stopColor="#f7d047" />
          <stop offset="100%" stopColor="#a86b3c" />
        </linearGradient>
        <filter id={glow} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <circle cx="186" cy="96" r="86" fill={`url(#${planet})`} />
      <ellipse
        cx="178"
        cy="128"
        rx="112"
        ry="34"
        fill="none"
        stroke="#f7d047"
        strokeOpacity="0.28"
        strokeWidth="1.4"
      />
      <g transform="translate(78 34) rotate(-12 66 78)" filter={`url(#${glow})`}>
        <rect width="132" height="156" rx="22" fill="#14120e" stroke="#f7d047" strokeWidth="2.5" />
        <text
          x="66"
          y="104"
          textAnchor="middle"
          fill="#6a5c40"
          fontSize="76"
          fontFamily="var(--font-geist-sans), sans-serif"
          fontWeight="650"
        >
          F
        </text>
      </g>
      <g transform="translate(124 62) rotate(8 62 66)">
        <rect width="124" height="132" rx="20" fill="#0c0b09" stroke="#f7d047" strokeWidth="2.5" />
        <text
          x="62"
          y="90"
          textAnchor="middle"
          fill="#8a7854"
          fontSize="68"
          fontFamily="var(--font-geist-sans), sans-serif"
          fontWeight="650"
        >
          F
        </text>
      </g>
      <g transform="translate(178 4)">
        <circle cx="34" cy="34" r="32" fill={`url(#${coin})`} />
        <circle cx="34" cy="34" r="24" fill="none" stroke="#1a1405" strokeOpacity="0.28" strokeWidth="1.6" />
        <text
          x="34"
          y="45"
          textAnchor="middle"
          fill="#1a1405"
          fontSize="30"
          fontFamily="var(--font-geist-sans), sans-serif"
          fontWeight="700"
        >
          F
        </text>
      </g>
      <g transform="translate(214 74)">
        <circle cx="26" cy="26" r="24" fill="#14120e" stroke="#f7d047" strokeWidth="2.2" />
        <path d="M14 27.5 28 16l-4.2 16.5-3.2-4.6-6.6 3.2V24" fill="#f7d047" />
      </g>
    </svg>
  );
}

function MethodRow({
  title,
  note,
  icon,
  onClick,
  disabled,
  recommended,
  recommendedLabel,
}: {
  title: string;
  note: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  recommended?: boolean;
  recommendedLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex min-h-14 w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        recommended
          ? 'border-sun/80 bg-sun/[0.07] hover:border-sun'
          : 'border-white/10 bg-black/20 hover:border-sun/40'
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-sans text-[14px] leading-5 text-paper">{title}</span>
          {recommended && recommendedLabel ? (
            <span className="rounded-full border border-sun/60 px-1.5 py-0.5 font-sans text-[9px] uppercase tracking-[0.12em] text-sun">
              {recommendedLabel}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-[12px] leading-4 text-muted">{note}</span>
      </span>
      <Chevron />
    </button>
  );
}

function DoorPanel({ next }: { next?: string }) {
  const { authenticated, user, logout } = usePrivy();
  const copy = CUSTODY_DOOR_COPY;
  const [soon, setSoon] = useState(false);
  const guest = custodyDoorIsGuest(user);
  function showSoon() {
    setSoon(true);
  }

  useEffect(() => {
    const header = document.querySelector('header');
    const footer = document.querySelector('footer');
    const previous = document.body.style.overflow;
    const desktop = window.matchMedia('(min-width: 1024px)');
    const apply = () => {
      footer?.setAttribute('inert', '');
      if (desktop.matches) header?.removeAttribute('inert');
      else header?.setAttribute('inert', '');
      document.body.style.overflow = 'hidden';
    };
    apply();
    desktop.addEventListener('change', apply);
    return () => {
      desktop.removeEventListener('change', apply);
      header?.removeAttribute('inert');
      footer?.removeAttribute('inert');
      document.body.style.overflow = previous;
    };
  }, []);

  const features = [
    { title: copy.featurePasskey, note: copy.featurePasskeyNote, icon: <ShieldIcon /> },
    { title: copy.featureAnywhere, note: copy.featureAnywhereNote, icon: <ChatIcon /> },
    { title: copy.featureFriends, note: copy.featureFriendsNote, icon: <BoltIcon /> },
  ];

  return (
    <>
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#07060a] font-sans text-paper lg:hidden">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute right-[-8%] top-[6%] h-72 w-72 rounded-full bg-sun/15 blur-3xl" />
        <div className="absolute left-[-20%] top-[18%] h-56 w-56 rounded-full bg-gold/10 blur-3xl" />
      </div>
      <div className="relative mx-auto flex min-h-dvh w-full max-w-[460px] flex-col px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.7rem,env(safe-area-inset-top))]">
        <header className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 no-underline">
            <span className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-sun font-sans text-lg font-semibold text-sun-ink">
              F
            </span>
            <span className="font-sans text-[15px] font-semibold tracking-[0.22em] text-paper">FLIZY</span>
          </Link>
          <Link
            href="/"
            aria-label={copy.close}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 text-paper no-underline hover:border-sun/50"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden>
              <path
                d="m5 5 10 10M15 5 5 15"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </Link>
        </header>

        <section className="relative mt-4 grid grid-cols-[minmax(0,1fr)_124px] items-center gap-2">
          <div>
            <p className="inline-flex items-center gap-1.5 rounded-full border border-sun/35 bg-sun/10 px-3 py-1 text-[12px] text-sun">
              <span className="flex h-3.5 w-3.5 items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5">
                <ShieldIcon />
              </span>
              {copy.kicker}
            </p>
            <h1 className="mt-2.5 font-sans text-[1.7rem] font-semibold leading-[1.02] tracking-tight text-paper min-[400px]:text-[1.95rem]">
              {copy.headline}
              <span className="mt-1 block text-sun">{copy.headlineAccent}</span>
            </h1>
            <p className="mt-3 text-[13px] leading-5 text-[#b7b1a8]">{copy.blurb}</p>
          </div>
          <div className="h-[136px] w-[124px] justify-self-end">
            <DoorArt />
          </div>
        </section>

        <ul className="mb-3 mt-3 grid grid-cols-3 gap-2">
          {features.map((feature) => (
            <li key={feature.title} className="text-center">
              <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-[14px] border border-sun/45 text-sun">
                {feature.icon}
              </span>
              <p className="mt-2 font-sans text-[13px] leading-4 text-paper">{feature.title}</p>
              <p className="mt-1 text-[11px] leading-4 text-muted">{feature.note}</p>
            </li>
          ))}
        </ul>

        <section className="mt-auto rounded-[28px] border border-white/10 bg-[#101114] px-3.5 pb-4 pt-2.5 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
          <div className="mx-auto h-1 w-10 rounded-full bg-white/20" aria-hidden />
          <h2 className="mt-2.5 text-center font-sans text-[1.4rem] font-semibold tracking-tight text-paper">
            {copy.title}
          </h2>
          <p className="mt-1 text-center text-sm text-muted">{copy.sheetNote}</p>

          {guest ? (
            <div role="status" className="mt-5 space-y-4 px-1">
              <p className="font-sans text-lg text-paper">{copy.guestTitle}</p>
              <p className="text-sm leading-6 text-muted">{copy.guestBody}</p>
              <button className="btn btn-primary w-full" type="button" onClick={showSoon}>
                {copy.guestUpgrade}
              </button>
              <p className="text-sm text-muted">{copy.guestUpgradeNote}</p>
              {soon ? (
                <p className="text-center text-sm text-sun" role="status">
                  {copy.soon}
                </p>
              ) : null}
              <button className="btn btn-ghost w-full text-sm" type="button" onClick={() => logout()}>
                {copy.guestLeave}
              </button>
            </div>
          ) : authenticated ? (
            <div role="status" className="mt-5 px-1">
              <p className="font-sans text-lg text-paper">{copy.signedInTitle}</p>
              <p className="mt-2 text-sm leading-6 text-muted">{copy.signedInBody}</p>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              <MethodRow
                title={copy.email}
                note={copy.emailNote}
                icon={
                  <IconBox>
                    <MailIcon />
                  </IconBox>
                }
                onClick={showSoon}
              />
              <MethodRow
                title={copy.google}
                note={copy.googleNote}
                icon={
                  <IconBox>
                    <GoogleMark />
                  </IconBox>
                }
                onClick={showSoon}
              />
              <MethodRow
                title={copy.guest}
                note={copy.guestNote}
                icon={
                  <IconBox>
                    <PersonIcon />
                  </IconBox>
                }
                onClick={showSoon}
              />
              <MethodRow
                title={copy.passkey}
                note={copy.passkeyNote}
                recommended
                recommendedLabel={copy.recommended}
                icon={
                  <IconBox mark>
                    <PasskeyIcon />
                  </IconBox>
                }
                onClick={showSoon}
              />
              {soon ? (
                <p className="text-center text-sm text-sun" role="status">
                  {copy.soon}
                </p>
              ) : null}
            </div>
          )}

          <p className="mt-3 flex items-center justify-center gap-2 text-xs text-muted">
            <span>{copy.protected}</span>
            <span className="inline-flex items-center gap-1.5 font-sans text-sm text-paper">
              <span className="h-2 w-2 rounded-full bg-sun" aria-hidden />
              {copy.privy}
            </span>
          </p>
          <p className="mt-3 text-center text-sm">
            <Link href={passwordLoginHref(next)} className="text-muted no-underline hover:text-sun">
              {copy.password}
            </Link>
          </p>
        </section>
      </div>
    </div>

    <div className="fixed inset-x-0 bottom-0 top-[69px] z-30 hidden overflow-y-auto bg-[#07060a] font-sans text-paper lg:block">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute left-[6%] top-[-8%] h-[420px] w-[420px] rounded-full bg-sun/10 blur-3xl" />
      </div>
      <div className="relative mx-auto grid min-h-full max-w-[1120px] grid-cols-[minmax(0,1fr)_440px] items-center gap-8 px-8 py-8">
        <div className="relative min-h-[540px]">
          <img
            src="/login/door-hero.jpg"
            alt=""
            className="pointer-events-none absolute -right-10 top-1/2 h-[500px] w-[500px] max-w-none -translate-y-1/2 object-contain [mask-image:radial-gradient(ellipse_at_68%_50%,#000_36%,transparent_68%)]"
          />
          <div className="relative z-10 max-w-[23rem]">
            <p className="inline-flex items-center gap-1.5 rounded-full border border-sun/40 bg-black/40 px-3 py-1 text-[13px] text-sun">
              <span className="flex h-3.5 w-3.5 items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5">
                <ShieldIcon />
              </span>
              {copy.kicker}
            </p>
            <h1 className="mt-5 font-sans text-[3.35rem] font-semibold leading-[0.96] tracking-tight text-paper">
              {copy.headline}
              <span className="mt-1 block text-sun">{copy.headlineAccent}</span>
            </h1>
            <p className="mt-5 max-w-[22rem] text-[15px] leading-6 text-[#c8c2b8]">{copy.deskBlurb}</p>
            <ul className="mt-8 space-y-5">
              {[
                { title: copy.featurePasskey, note: copy.featurePasskeyNote, icon: <KeyIcon /> },
                { title: copy.featureAnywhere, note: copy.featureAnywhereNote, icon: <ChatIcon /> },
                { title: copy.featureFriends, note: copy.featureFriendsNote, icon: <BoltIcon /> },
              ].map((feature) => (
                <li key={feature.title} className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-[12px] border border-sun/50 text-sun">
                    {feature.icon}
                  </span>
                  <span>
                    <span className="block font-sans text-[15px] text-paper">{feature.title}</span>
                    <span className="mt-0.5 block text-[13px] text-muted">{feature.note}</span>
                  </span>
                </li>
              ))}
            </ul>
            <Link
              href="/how-it-works"
              className="mt-8 flex max-w-[360px] items-center gap-3 rounded-2xl border border-sun/35 bg-black/50 p-3 no-underline hover:border-sun/60"
            >
              <span className="flex h-14 w-11 items-center justify-center rounded-lg border border-white/15 bg-[#14120e] text-sun" aria-hidden>
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none">
                  <rect x="7" y="3" width="10" height="18" rx="2" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M10 18h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </span>
              <span className="min-w-0 flex-1 font-sans text-[15px] leading-5 text-paper">{copy.promo}</span>
              <Chevron />
            </Link>
          </div>
        </div>

        <section className="rounded-[28px] border border-white/10 bg-[#12110e] px-7 py-8 shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[14px] border border-sun/50 font-sans text-xl font-semibold text-sun">
            F
          </div>
          <h2 className="mt-4 text-center font-sans text-[1.85rem] font-semibold tracking-tight text-paper">
            {copy.title}
          </h2>
          <p className="mx-auto mt-2 max-w-[20rem] text-center text-sm leading-6 text-muted">{copy.cardBlurb}</p>

          {guest ? (
            <div role="status" className="mt-6 space-y-4">
              <p className="font-sans text-lg text-paper">{copy.guestTitle}</p>
              <p className="text-sm leading-6 text-muted">{copy.guestBody}</p>
              <button className="btn btn-primary w-full" type="button" onClick={showSoon}>
                {copy.guestUpgrade}
              </button>
              <p className="text-sm text-muted">{copy.guestUpgradeNote}</p>
              {soon ? (
                <p className="text-center text-sm text-sun" role="status">
                  {copy.soon}
                </p>
              ) : null}
              <button className="btn btn-ghost w-full text-sm" type="button" onClick={() => logout()}>
                {copy.guestLeave}
              </button>
            </div>
          ) : authenticated ? (
            <div role="status" className="mt-6">
              <p className="font-sans text-lg text-paper">{copy.signedInTitle}</p>
              <p className="mt-2 text-sm leading-6 text-muted">{copy.signedInBody}</p>
            </div>
          ) : (
            <div className="mt-6 space-y-3">
              <button
                type="button"
                onClick={showSoon}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl bg-sun px-4 py-3 text-left text-sun-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FingerprintIcon />
                <span className="min-w-0 flex-1 whitespace-nowrap font-sans text-[15px] font-semibold">{copy.passkey}</span>
                <span className="shrink-0 rounded-md bg-black/15 px-2 py-1 font-sans text-[11px] text-sun-ink/80">
                  {copy.recommended}
                </span>
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden>
                  <path d="m7.5 4.5 5 5.5-5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                onClick={showSoon}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-white/12 px-4 py-3 text-left hover:border-sun/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <MailIcon />
                <span className="min-w-0 flex-1 font-sans text-[15px] text-paper">{copy.email}</span>
                <Chevron />
              </button>
              <button
                type="button"
                onClick={showSoon}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-white/12 px-4 py-3 text-left hover:border-sun/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <GoogleColorMark />
                <span className="min-w-0 flex-1 font-sans text-[15px] text-paper">{copy.google}</span>
                <Chevron />
              </button>
              <button
                type="button"
                onClick={showSoon}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-white/12 px-4 py-3 text-left hover:border-sun/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <PersonIcon />
                <span className="min-w-0 flex-1">
                  <span className="block font-sans text-[15px] text-paper">{copy.guest}</span>
                  <span className="mt-0.5 block text-[13px] text-muted">{copy.deskGuestNote}</span>
                </span>
                <Chevron />
              </button>
              {soon ? (
                <p className="text-center text-sm text-sun" role="status">
                  {copy.soon}
                </p>
              ) : null}
            </div>
          )}

          <div className="mt-5 flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-white/10" />
            or
            <span className="h-px flex-1 bg-white/10" />
          </div>
          <p className="mt-4 text-center text-sm">
            <Link href={passwordLoginHref(next)} className="inline-flex items-center gap-1.5 font-sans text-sun no-underline hover:text-paper">
              {copy.passwordInstead}
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden>
                <path d="m7.5 4.5 5 5.5-5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </Link>
          </p>
          <p className="mt-5 flex items-center justify-center gap-2 text-xs text-muted">
            <span>{copy.protected}</span>
            <span className="inline-flex items-center gap-1.5 font-sans text-sm text-paper">
              <span className="h-2 w-2 rounded-full bg-sun" aria-hidden />
              {copy.privy}
            </span>
          </p>
        </section>
      </div>
    </div>
    </>
  );
}

export function CustodyDoor({ next }: { next?: string }) {
  const appId = custodyDoorAppId();
  if (!appId) return null;
  return (
    <PrivyProvider appId={appId} config={privyConfig}>
      <DoorPanel next={next} />
    </PrivyProvider>
  );
}
