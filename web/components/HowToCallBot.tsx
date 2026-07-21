'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { GIWA_BRIDGE_URL, GIWA_FAUCET_URL } from '../lib/botPublic';

/** Display-only dial codes (educational). Not a real phone directory. */
const COUNTRY_CODES = [
  { code: '+44', label: 'United Kingdom' },
  { code: '+1', label: 'United States / Canada' },
  { code: '+234', label: 'Nigeria' },
  { code: '+91', label: 'India' },
  { code: '+27', label: 'South Africa' },
  { code: '+254', label: 'Kenya' },
  { code: '+233', label: 'Ghana' },
  { code: '+49', label: 'Germany' },
  { code: '+33', label: 'France' },
  { code: '+971', label: 'UAE' },
  { code: '+65', label: 'Singapore' },
  { code: '+81', label: 'Japan' },
  { code: '+61', label: 'Australia' },
  { code: '+55', label: 'Brazil' },
] as const;

/**
 * Clean how-to block. Does not publish the operator's real WhatsApp number.
 * Country code picker is for understanding international format only.
 */
export function HowToCallBot({ compact = false }: { compact?: boolean }) {
  const [dial, setDial] = useState('+44');

  const sampleDisplay = useMemo(() => `${dial}  ••• ••• ••••`, [dial]);

  return (
    <section className={compact ? 'space-y-5' : 'card space-y-6 p-5 sm:p-8'}>
      {/* Header */}
      <div className="max-w-2xl">
        <p className="text-xs uppercase tracking-[0.18em] text-gold">How to call the bot</p>
        <h2 className="mt-2 font-sans text-xl tracking-wide text-paper sm:text-2xl">
          Where to message Flizy
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Same steps in every country. You need WhatsApp and a browser. Commands start with{' '}
          <span className="text-paper">flizy</span>.
        </p>
      </div>

      {/* Number row: country code + masked sample (not a real line) */}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,11rem)_1fr]">
        <div>
          <label className="label" htmlFor="dial-code">
            Country code
          </label>
          <select
            id="dial-code"
            className="input"
            value={dial}
            onChange={(e) => setDial(e.target.value)}
          >
            {COUNTRY_CODES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} · {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <p className="label">Bot chat (example format)</p>
          <div className="mono-box flex min-h-[44px] items-center text-base text-lime sm:text-lg">
            {sampleDisplay}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            Example only. Your real bot chat opens from the dashboard after signup (number is not
            listed on this public page).
          </p>
        </div>
      </div>

      {/* A / B / ! — single column, clear like the original */}
      <div className="space-y-4 border-t border-border pt-5">
        <div className="flex gap-3 sm:gap-4">
          <span className="w-5 shrink-0 font-sans text-lime">A</span>
          <div className="min-w-0">
            <p className="text-sm text-paper">From your phone (any country)</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Sign up → Dashboard → WhatsApp link → <span className="text-paper">Open WhatsApp</span>.
              That opens the bot chat for you. Then type{' '}
              <span className="text-lime">flizy help</span>.
            </p>
          </div>
        </div>
        <div className="flex gap-3 sm:gap-4">
          <span className="w-5 shrink-0 font-sans text-lime">B</span>
          <div className="min-w-0">
            <p className="text-sm text-paper">If you host the bot on this device</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              WhatsApp → <span className="text-paper">Message yourself</span>, then type{' '}
              <span className="text-lime">flizy help</span>.
            </p>
          </div>
        </div>
        <div className="flex gap-3 sm:gap-4">
          <span className="w-5 shrink-0 font-sans text-gold">!</span>
          <div className="min-w-0">
            <p className="text-sm text-paper">Do not</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Type Flizy commands inside other people&apos;s chats or groups.
            </p>
          </div>
        </div>
      </div>

      {/* CTAs */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Link href="/signup" className="btn btn-primary w-full justify-center sm:w-auto">
          Create account
        </Link>
        <Link href="/dashboard" className="btn btn-ghost w-full justify-center sm:w-auto">
          Open dashboard
        </Link>
      </div>

      {/* Fund — tight two cards */}
      <div className="border-t border-border pt-6">
        <p className="text-xs uppercase tracking-[0.18em] text-gold">Get test ETH</p>
        <h3 className="mt-2 font-sans text-base tracking-wide text-paper sm:text-lg">
          Fund your agent wallet
        </h3>
        <p className="mt-2 text-sm text-muted">
          Copy your agent address from the dashboard, then use a faucet and/or bridge to GIWA
          Sepolia.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <a
            href={GIWA_FAUCET_URL}
            target="_blank"
            rel="noreferrer"
            className="flex flex-col rounded border border-border bg-ink/60 p-4 no-underline transition-colors hover:border-[rgba(224,184,74,0.35)]"
          >
            <span className="font-sans text-sm text-lime">Google Web3 faucet</span>
            <span className="mt-2 text-xs leading-relaxed text-muted">
              Free test ETH for development networks.
            </span>
          </a>
          <a
            href={GIWA_BRIDGE_URL}
            target="_blank"
            rel="noreferrer"
            className="flex flex-col rounded border border-border bg-ink/60 p-4 no-underline transition-colors hover:border-[rgba(224,184,74,0.35)]"
          >
            <span className="font-sans text-sm text-lime">GIWA bridge</span>
            <span className="mt-2 text-xs leading-relaxed text-muted">
              Bridge test assets onto GIWA Sepolia.
            </span>
          </a>
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <a
            href={GIWA_FAUCET_URL}
            className="btn btn-primary w-full justify-center sm:w-auto"
            target="_blank"
            rel="noreferrer"
          >
            Open faucet
          </a>
          <a
            href={GIWA_BRIDGE_URL}
            className="btn btn-ghost w-full justify-center sm:w-auto"
            target="_blank"
            rel="noreferrer"
          >
            Open bridge
          </a>
        </div>
      </div>

      {/* Commands — compact grid */}
      {!compact ? (
        <div className="border-t border-border pt-6">
          <p className="text-xs text-muted">Quick commands</p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              'flizy help',
              'flizy me',
              'flizy balance',
              'flizy add wallet 0x…',
              'flizy send 0.0001 to john',
              'confirm',
            ].map((c) => (
              <div key={c} className="mono-box py-2 text-xs text-lime sm:text-sm">
                {c}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            After a pending send, bare <span className="text-paper">confirm</span> works too.
          </p>
        </div>
      ) : null}
    </section>
  );
}
