'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { GIWA_FAUCET_URL } from '../lib/botPublic';

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
 * Multi-user guide. One shared bot per channel; each user is a different chat.
 * The same account can be linked on WhatsApp and Telegram at the same time.
 */
export function HowToCallBot({ compact = false }: { compact?: boolean }) {
  const [dial, setDial] = useState('+44');
  const sampleDisplay = useMemo(() => `${dial}  ••• ••• ••••`, [dial]);

  return (
    <section className={compact ? 'space-y-5' : 'card space-y-6 p-5 sm:p-8'}>
      <div className="max-w-2xl">
        <p className="text-xs uppercase tracking-[0.18em] text-gold">How to call the bot</p>
        <h2 className="mt-2 font-sans text-xl tracking-wide text-paper sm:text-2xl">
          One bot. Many users.
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Flizy runs <span className="text-paper">one bot on WhatsApp and one on Telegram</span>.
          Everyone (you and your friends) messages that same bot. Each person is recognized by{' '}
          <span className="text-paper">their own chat id</span>, not by sharing your phone.
        </p>
      </div>

      <div className="rounded border border-border bg-ink/50 p-4 text-sm leading-relaxed text-muted">
        <p className="font-sans text-paper">If a friend signs up</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>They create an account on this website (their email).</li>
          <li>
            On <span className="text-paper">their phone</span>, they open Dashboard → Connect a chat
            app → Generate code → <span className="text-paper">Open WhatsApp</span> or{' '}
            <span className="text-paper">Open Telegram</span>.
          </li>
          <li>They send the link message from their own chat app to the bot.</li>
          <li>
            The bot replies <span className="text-paper">in their chat</span> (not in yours).
          </li>
        </ol>
        <p className="mt-3 text-xs">
          One code works on either app, and one account can hold both. Message yourself is only for
          the person who runs the WhatsApp bot on that phone. Friends link from the dashboard on
          their own device.
        </p>
      </div>

      <div className="rounded border border-border bg-ink/50 p-4 text-sm leading-relaxed text-muted">
        <p className="font-sans text-paper">Same account, two chat apps</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-gold">WhatsApp</p>
            <p className="mt-1.5 font-mono text-xs text-lime">flizy send 0.001 to john</p>
            <p className="mt-1.5 text-xs">Then reply confirm. Commands start with flizy.</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-gold">Telegram</p>
            <p className="mt-1.5 font-mono text-xs text-lime">/send 0.001 to john</p>
            <p className="mt-1.5 text-xs">
              Then tap Confirm. Share your number with /phone so claims sent to it reach you.
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs">
          Same wallet, same trusted list, same limits, same history on both. A number belongs to
          exactly one Flizy account.
        </p>
      </div>

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
          <label className="label">Number format (example only)</label>
          <div className="mono-box flex min-h-[44px] items-center text-base text-lime sm:text-lg">
            {sampleDisplay}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            Example format for any country. The live bot number is not shown on the public site.
            Users open the bot from the dashboard after signup.
          </p>
        </div>
      </div>

      <div className="space-y-4 border-t border-border pt-5">
        <div className="flex gap-3 sm:gap-4">
          <span className="w-5 shrink-0 font-sans text-lime">A</span>
          <div className="min-w-0">
            <p className="text-sm text-paper">Any user (recommended)</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Sign up → Dashboard → Connect a chat app → Open WhatsApp or Telegram → send the code.
              Chat stays between that user and the bot.
            </p>
          </div>
        </div>
        <div className="flex gap-3 sm:gap-4">
          <span className="w-5 shrink-0 font-sans text-lime">B</span>
          <div className="min-w-0">
            <p className="text-sm text-paper">Bot operator only</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              If this phone hosts the bot, you can test in Message yourself. Friends should not use
              that — they use A on their own phones.
            </p>
          </div>
        </div>
        <div className="flex gap-3 sm:gap-4">
          <span className="w-5 shrink-0 font-sans text-gold">!</span>
          <div className="min-w-0">
            <p className="text-sm text-paper">Do not</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Type Flizy commands inside random contacts or groups. Only the bot chat counts.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Link href="/signup" className="btn btn-primary w-full justify-center sm:w-auto">
          Create account
        </Link>
        <Link href="/dashboard" className="btn btn-ghost w-full justify-center sm:w-auto">
          Open dashboard
        </Link>
      </div>

      <div className="border-t border-border pt-6">
        <p className="text-xs uppercase tracking-[0.18em] text-gold">Get test ETH</p>
        <h3 className="mt-2 font-sans text-base tracking-wide text-paper sm:text-lg">
          Fund your Flizy wallet
        </h3>
        <p className="mt-2 text-sm text-muted">
          Open the official GIWA faucet, paste your Flizy wallet address from the dashboard (Wallet
          tab), and request test ETH. No bridge. No MetaMask required for the faucet.
        </p>
        <ol className="mt-4 space-y-2 text-xs leading-relaxed text-muted sm:text-sm">
          <li>
            <span className="text-paper">1.</span> Copy your Flizy wallet address from Wallet → Fund
          </li>
          <li>
            <span className="text-paper">2.</span> Open{' '}
            <a
              href={GIWA_FAUCET_URL}
              target="_blank"
              rel="noreferrer"
              className="text-lime no-underline hover:text-gold"
            >
              faucet.giwa.io
            </a>
          </li>
          <li>
            <span className="text-paper">3.</span> Paste that address and request funds
          </li>
        </ol>
        <div className="mt-4">
          <a
            href={GIWA_FAUCET_URL}
            className="btn btn-primary w-full justify-center sm:w-auto"
            target="_blank"
            rel="noreferrer"
          >
            Open GIWA faucet
          </a>
        </div>
      </div>

      {!compact ? (
        <div className="border-t border-border pt-6">
          <p className="text-xs text-muted">
            Quick commands (WhatsApp form shown, Telegram uses the same words with a slash)
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              ['flizy help', '/help'],
              ['flizy me', '/me'],
              ['flizy balance', '/balance'],
              ['flizy add wallet 0x…', '/add wallet 0x…'],
              ['flizy send 0.0001 to john', '/send 0.0001 to john'],
              ['confirm', 'confirm or the button'],
            ].map(([wa, tg]) => (
              <div key={wa} className="mono-box py-2 text-xs text-lime sm:text-sm">
                <span>{wa}</span>
                <span className="ml-2 text-muted">· {tg}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
