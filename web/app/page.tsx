import Link from 'next/link';
import { HowToCallBot } from '../components/HowToCallBot';
import { ResumeChatLink } from '../components/ResumeChatLink';
import { hasSessionCookie } from '../lib/cookies';

/**
 * Page order is deliberate: promise → proof → audience → mechanism → funding.
 * The chat example sits directly under the hero because it demonstrates the
 * product in four lines, which no amount of description does as well.
 */

const AUDIENCE = [
  {
    mark: 'Y',
    t: 'For you',
    d: 'Open a wallet, save the people you pay, link WhatsApp or Telegram once.',
  },
  {
    mark: 'F',
    t: 'For the people you pay',
    d: 'They receive only if you already saved their address. Nothing to install on their side.',
  },
  {
    mark: 'W',
    t: 'One wallet, everywhere',
    d: 'The same Flizy wallet on the site and in chat. Permanent, never rotated.',
  },
];

const WHY = [
  {
    t: 'WhatsApp and Telegram',
    d: 'One link code, either chat app, the same account. Chat the bot like any contact.',
  },
  {
    t: 'Trusted list',
    d: 'Only names you save can receive funds. Managed on the site or via flizy add wallet.',
  },
  {
    t: 'Your wallet sends',
    d: 'Sends leave from your Flizy wallet. Fund it via the official GIWA faucet (paste your Flizy address).',
  },
];

const FUND_STEPS = [
  {
    n: '01',
    t: 'Copy Flizy address',
    d: 'Sign up, open Wallet → Fund, copy your Flizy wallet address.',
    href: '/signup',
  },
  {
    n: '02',
    t: 'Open GIWA faucet',
    d: 'Visit the official faucet for GIWA testnet.',
    href: 'https://faucet.giwa.io',
  },
  {
    n: '03',
    t: 'Paste and request',
    d: 'Paste your Flizy wallet address and claim test ETH into it.',
    href: 'https://faucet.giwa.io',
  },
];

export default function HomePage() {
  const signedIn = hasSessionCookie();
  return (
    <div className="fade-up space-y-12 md:space-y-24">
      {signedIn ? <ResumeChatLink /> : null}
      {/* Hero — one promise, one proof point, one primary action */}
      <section className="hero-grid relative -mx-6 px-6 py-12 md:py-24">
        <div className="max-w-3xl">
          <h1 className="font-sans text-3xl font-semibold tracking-wide text-paper sm:text-4xl md:text-6xl md:leading-[1.08]">
            Send crypto on WhatsApp and Telegram.
            <br />
            <span className="bg-gradient-to-r from-[#e8c45a] to-[#c4893f] bg-clip-text text-transparent">
              Only to people you trust.
            </span>
          </h1>

          <p className="mt-6 max-w-xl font-sans text-base leading-relaxed text-paper md:mt-8 md:text-xl">
            A stolen phone cannot add a new destination.
          </p>

          <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted md:text-lg">
            You approve who you are allowed to pay here on the site. In chat, you just send. One
            account works on both apps.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3 md:mt-10">
            {signedIn ? (
              <>
                <Link href="/dashboard" className="btn btn-primary">
                  Open app
                </Link>
                <Link href="/dashboard/account?s=chat" className="btn btn-ghost">
                  Chat apps
                </Link>
              </>
            ) : (
              <>
                <Link href="/signup" className="btn btn-primary">
                  Create free account
                </Link>
                <Link href="/how-it-works" className="btn btn-ghost">
                  See how it works
                </Link>
              </>
            )}
          </div>

          <p className="mt-5 text-xs text-muted">
            {signedIn ? (
              'You are signed in. Continue in the app.'
            ) : (
              <>
                Free to start. No seed phrases in chat. Running on GIWA Sepolia testnet.{' '}
                <Link href="/login" className="text-muted underline-offset-4 hover:text-lime">
                  Already have an account?
                </Link>
              </>
            )}
          </p>
        </div>
      </section>

      {/* Proof — the product in four lines */}
      <section className="card overflow-hidden">
        <div className="grid md:grid-cols-2">
          <div className="border-b border-border p-6 md:border-b-0 md:border-r md:p-10">
            <p className="text-xs uppercase tracking-[0.18em] text-gold">Example in chat</p>
            <div className="mt-6 space-y-3 font-mono text-sm">
              <p className="text-muted">You</p>
              <p className="mono-box text-paper">flizy send 0.001 to nald</p>
              <p className="text-muted">Bot</p>
              <p className="mono-box text-lime">Pending. Reply confirm</p>
              <p className="mono-box text-paper">confirm</p>
              <p className="mono-box text-lime">https://sepolia-explorer.giwa.io/tx/0x…</p>
            </div>
          </div>
          <div className="flex flex-col justify-center p-6 md:p-10">
            <h2 className="font-sans text-2xl tracking-wide text-paper">That is the whole thing</h2>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              No addresses to paste, no network to pick, no seed phrase to guard. On Telegram the
              same send is <span className="font-mono text-paper">/send 0.001 to nald</span>, and
              you confirm with a button.
            </p>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              <span className="text-paper">nald</span> is a name you saved on the site. If it is not
              on your list, the send does not happen — from any device, on any chat.
            </p>
          </div>
        </div>
      </section>

      {/* Audience — now visible at every breakpoint */}
      <section className="space-y-6">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-gold">Who it is for</p>
          <h2 className="mt-2 font-sans text-2xl tracking-wide text-paper">
            Anyone who already pays people they know
          </h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-3 sm:gap-4">
          {AUDIENCE.map((card) => (
            <div key={card.t} className="card flex items-start gap-3 p-4 sm:flex-col sm:p-5">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-ink font-sans text-xs text-lime">
                {card.mark}
              </span>
              <div>
                <h3 className="font-sans text-sm tracking-wide text-paper sm:text-base">
                  {card.t}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-muted sm:mt-2 sm:text-sm">
                  {card.d}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <HowToCallBot />

      <section className="space-y-6">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-gold">Also</p>
          <h2 className="mt-2 font-sans text-2xl tracking-wide text-paper">Why Flizy</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {WHY.map((item) => (
            <div key={item.t} className="card card-hover p-5">
              <h3 className="font-sans text-base tracking-wide text-paper">{item.t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{item.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card space-y-4 p-5 md:p-8">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-gold">Testnet</p>
          <h2 className="mt-2 font-sans text-2xl tracking-wide text-paper">
            How to fund (GIWA faucet)
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Use the official GIWA faucet. Copy your Flizy wallet address from the dashboard (Wallet
            → Fund), open faucet.giwa.io, paste that address, and request test ETH. No bridge step.
          </p>
        </div>
        <ol className="grid gap-3 sm:grid-cols-3">
          {FUND_STEPS.map((s) => (
            <li key={s.n} className="rounded-md border border-border bg-ink/40 p-4">
              <p className="font-mono text-[10px] text-lime">{s.n}</p>
              <h3 className="mt-1 font-sans text-sm tracking-wide text-paper">{s.t}</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">{s.d}</p>
              <a
                href={s.href}
                className="mt-2 inline-block text-xs text-lime no-underline hover:text-gold"
                target={s.href.startsWith('http') ? '_blank' : undefined}
                rel={s.href.startsWith('http') ? 'noreferrer' : undefined}
              >
                Open →
              </a>
            </li>
          ))}
        </ol>
      </section>

      {/* Closing CTA */}
      <section className="card p-6 md:p-10">
        <h2 className="font-sans text-2xl tracking-wide text-paper">Ready when you are</h2>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
          Create an account, save one person you trust, link WhatsApp or Telegram, and try a tiny
          test send. On Android Chrome, use Install app for a full-screen Flizy icon.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link href="/signup" className="btn btn-primary">
            Get started
          </Link>
          <Link href="/docs" className="btn btn-ghost">
            See every command
          </Link>
        </div>
      </section>
    </div>
  );
}
