import Link from 'next/link';
import { HowToCallBot } from '../components/HowToCallBot';

export default function HomePage() {
  return (
    <div className="fade-up space-y-12 md:space-y-24">
      <section className="hero-grid relative -mx-6 px-6 py-12 md:py-24">
        <div className="max-w-3xl">
          <p className="badge badge-gold mb-5">GIWA-first EVM</p>
          <h1 className="font-sans text-3xl font-semibold tracking-wide text-paper sm:text-4xl md:text-6xl md:leading-[1.08]">
            Send crypto from your chat app.
            <br />
            <span className="bg-gradient-to-r from-[#e8c45a] to-[#c4893f] bg-clip-text text-transparent">
              Only to people you trust.
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-sm leading-relaxed text-muted md:mt-8 md:text-lg">
            Flizy is a chat wallet for real life, on WhatsApp and Telegram. One account, both
            chats. You manage trusted addresses and your unlock PIN here. On chat, you just send.
            A stolen phone cannot add a new destination.
          </p>

          <div className="mt-8 flex flex-wrap gap-2 md:mt-10 md:gap-3">
            <Link href="/signup" className="btn btn-primary">
              Create free account
            </Link>
            <Link href="/how-it-works" className="btn btn-ghost">
              See how it works
            </Link>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/login" className="btn btn-ghost text-sm">
              Log in
            </Link>
            <Link href="/dashboard" className="btn btn-ghost text-sm">
              Open app
            </Link>
          </div>
          <p className="mt-5 text-xs text-muted">
            No seed phrases in chat. Install from Chrome for a home-screen app.
          </p>
        </div>
      </section>

      <section className="space-y-3 md:hidden">
        {[
          {
            t: 'For you',
            mark: 'Y',
            d: 'Open a wallet, add trusted names, link WhatsApp or Telegram once.',
          },
          {
            t: 'For friends',
            mark: 'F',
            d: 'They only receive if you already saved their address.',
          },
          {
            t: 'For agents',
            mark: 'A',
            d: 'Same agent wallet on site and chat — permanent, not rotated.',
          },
        ].map((card) => (
          <div key={card.t} className="card flex items-start gap-3 p-4">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-ink font-sans text-xs text-lime">
              {card.mark}
            </span>
            <div>
              <p className="font-sans text-sm tracking-wide text-paper">{card.t}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{card.d}</p>
            </div>
          </div>
        ))}
      </section>

      <HowToCallBot />

      <section className="space-y-6">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-gold">Also</p>
          <h2 className="mt-2 font-sans text-2xl tracking-wide text-paper">Why Flizy</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {[
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
          ].map((item) => (
            <div key={item.t} className="card card-hover p-5">
              <h2 className="font-sans text-base tracking-wide text-paper">{item.t}</h2>
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
          {[
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
          ].map((s) => (
            <li key={s.n} className="rounded-md border border-border bg-ink/40 p-4">
              <p className="font-mono text-[10px] text-lime">{s.n}</p>
              <p className="mt-1 font-sans text-sm tracking-wide text-paper">{s.t}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{s.d}</p>
              {'href' in s && s.href ? (
                <a
                  href={s.href}
                  className="mt-2 inline-block text-xs text-lime no-underline hover:text-gold"
                  target={s.href.startsWith('http') ? '_blank' : undefined}
                  rel={s.href.startsWith('http') ? 'noreferrer' : undefined}
                >
                  Open →
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

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
            <p className="mt-6 text-xs leading-relaxed text-muted">
              On Telegram the same thing is <span className="font-mono">/send 0.001 to nald</span>,
              and you confirm with a button.
            </p>
          </div>
          <div className="flex flex-col justify-center p-6 md:p-10">
            <h2 className="font-sans text-2xl tracking-wide text-paper">Ready when you are</h2>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              Create an account, add one trusted address, link WhatsApp or Telegram, and try a tiny
              test send on GIWA Sepolia. On Android Chrome, use Install app for a full-screen Flizy
              icon.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/signup" className="btn btn-primary">
                Get started
              </Link>
              <Link href="/login" className="btn btn-ghost">
                I already have an account
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
