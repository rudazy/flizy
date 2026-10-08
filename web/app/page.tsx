import Link from 'next/link';
import { HeroVideo } from '../components/HeroVideo';
import { PayPeople } from '../components/PayPeople';
import { ResumeChatLink } from '../components/ResumeChatLink';
import { hasSessionCookie } from '../lib/cookies';

/**
 * Opening page. The video stays beside the headline. The phone row shows how
 * a country code is applied on the site and required in chat.
 */

const FEATURES = [
  {
    t: 'Send and receive',
    d: 'Pay a username, phone number or email. If they are not on Flizy yet, the money waits and you can cancel it.',
  },
  {
    t: 'Trade',
    d: 'Buy and sell listed tokens from chat or the swap screen. You see the quote before you confirm.',
  },
  {
    t: 'NFTs',
    d: 'Mint, send and trade NFTs on GIWA. The same wallet is behind the site and the chat.',
  },
  {
    t: 'One account',
    d: 'WhatsApp, Telegram and the site share one wallet, one history and the same limits.',
  },
];

const WHY = [
  {
    t: 'No complex setup',
    d: 'No seed phrase in chat, and no network to pick. Link WhatsApp or Telegram once.',
  },
  {
    t: 'Pay anyone',
    d: 'A Flizy username, or a phone number or email, even before they join.',
  },
  {
    t: 'Your wallet, your rules',
    d: 'A raw address works only after you save it on the site with your password, and a new one waits 24 hours.',
  },
];

const FUND_STEPS = [
  {
    n: '01',
    t: 'Create your account',
    d: 'Sign up and verify your email.',
    href: '/signup',
  },
  {
    n: '02',
    t: 'Choose a username',
    d: 'Your @username is how people pay you.',
    href: '/dashboard/account',
  },
  {
    n: '03',
    t: 'Claim in one tap',
    d: 'Open Wallet, then Fund, and tap Claim. 0.02 test ETH, once every 72 hours.',
    href: '/dashboard/wallet?s=fund',
  },
];

export default function HomePage() {
  const signedIn = hasSessionCookie();
  return (
    <div className="fade-up space-y-16 md:space-y-24">
      {signedIn ? <ResumeChatLink /> : null}

      <section className="hero-grid relative -mx-6 grid gap-10 px-6 py-8 md:py-16 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-center lg:gap-14">
        <div className="max-w-xl">
          <p className="text-xs uppercase tracking-[0.22em] text-gold">Simple · Social · On GIWA</p>
          <h1 className="mt-4 font-sans text-4xl font-semibold tracking-wide text-paper sm:text-5xl md:leading-[1.05] lg:text-5xl xl:text-6xl">
            Your crypto wallet,
            <span className="mt-1 block bg-gradient-to-r from-[#e8c45a] to-[#c4893f] bg-clip-text text-transparent">
              inside your chats.
            </span>
          </h1>
          <p className="mt-6 font-sans text-base leading-relaxed text-paper md:text-lg">
            Send, receive and trade through WhatsApp, Telegram or the Flizy app. Tell Flizy who
            and how much. You confirm before anything moves.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {signedIn ? (
              <>
                <Link href="/dashboard" className="btn btn-primary min-h-[44px]">
                  Open app
                </Link>
                <Link href="/how-it-works" className="btn btn-ghost min-h-[44px]">
                  See how it works
                </Link>
              </>
            ) : (
              <>
                <Link href="/signup" className="btn btn-primary min-h-[44px]">
                  Open app
                </Link>
                <Link href="/how-it-works" className="btn btn-ghost min-h-[44px]">
                  See how it works
                </Link>
              </>
            )}
          </div>
          <p className="mt-5 text-xs leading-relaxed text-muted">
            {signedIn ? (
              'You are signed in. Continue in the app.'
            ) : (
              <>
                One account. Works on WhatsApp and Telegram. GIWA Sepolia testnet.{' '}
                <Link href="/login" className="text-muted underline-offset-4 hover:text-lime">
                  Already have an account?
                </Link>
              </>
            )}
          </p>
        </div>
        <HeroVideo />
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((item) => (
          <div key={item.t} className="card p-5">
            <h2 className="font-sans text-base tracking-wide text-paper">{item.t}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">{item.d}</p>
          </div>
        ))}
      </section>

      <section className="space-y-6" id="pay">
        <div className="max-w-2xl">
          <p className="text-xs uppercase tracking-[0.18em] text-gold">Pay people, not addresses</p>
          <h2 className="mt-2 font-sans text-3xl tracking-wide text-paper md:text-4xl">
            Send to a Flizy username or phone number.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted md:text-base">
            On the site the country is selected for you. In chat, include the country code.
            Flizy stores every number the same way.
          </p>
        </div>
        <PayPeople />
      </section>

      <section className="space-y-6">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-gold">See it in action</p>
          <h2 className="mt-2 font-sans text-3xl tracking-wide text-paper">Simple commands.</h2>
          <p className="mt-2 text-sm text-muted">The same experience on WhatsApp and Telegram.</p>
        </div>
        <div className="card overflow-hidden">
          <div className="grid md:grid-cols-2">
            <div className="border-b border-border p-6 md:border-b-0 md:border-r md:p-8">
              <div className="space-y-3 font-mono text-sm">
                <p className="text-muted">You</p>
                <p className="mono-box text-paper">flizy send 0.01 ETH to +234 708 043 7343</p>
                <p className="text-muted">Flizy</p>
                <p className="mono-box text-lime">Pending. Reply CONFIRM</p>
                <p className="text-muted">You</p>
                <p className="mono-box text-paper">confirm</p>
                <p className="text-muted">Flizy</p>
                <p className="mono-box text-lime">Sent. https://sepolia-explorer.giwa.io/tx/0x…</p>
              </div>
            </div>
            <div className="flex flex-col justify-center gap-3 p-6 md:p-8">
              <p className="font-mono text-sm text-paper">flizy send 0.01 to @ada</p>
              <p className="text-xs text-muted">A Flizy username</p>
              <p className="font-mono text-sm text-paper">flizy send 0.01 ETH to +234 708 043 7343</p>
              <p className="text-xs text-muted">A phone number, country code included</p>
              <p className="font-mono text-sm text-paper">flizy send 0.01 to ada@email.com</p>
              <p className="text-xs text-muted">An email, held until they claim</p>
              <Link href="/docs" className="mt-2 text-sm text-lime no-underline hover:text-gold">
                Every command
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-6">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-gold">Why Flizy</p>
          <h2 className="mt-2 font-sans text-3xl tracking-wide text-paper">Built for real people.</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            Flizy brings the wallet to the chats you already use.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {WHY.map((item) => (
            <div key={item.t} className="card p-5">
              <h3 className="font-sans text-base tracking-wide text-paper">{item.t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{item.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card space-y-4 p-5 md:p-8">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-gold">Get test ETH (GIWA)</p>
          <h2 className="mt-2 font-sans text-2xl tracking-wide text-paper">Fund your Flizy wallet</h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            One tap puts 0.02 GIWA test ETH straight into your Flizy wallet. No address to copy and
            no other site.
          </p>
        </div>
        <ol className="grid gap-3 sm:grid-cols-3">
          {FUND_STEPS.map((step) => (
            <li key={step.n} className="rounded-md border border-border bg-ink/40 p-4">
              <p className="font-mono text-[10px] text-lime">{step.n}</p>
              <h3 className="mt-1 font-sans text-sm tracking-wide text-paper">{step.t}</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">{step.d}</p>
              <a
                href={step.href}
                className="mt-3 inline-flex min-h-[44px] items-center text-xs text-lime no-underline hover:text-gold"
                target={step.href.startsWith('http') ? '_blank' : undefined}
                rel={step.href.startsWith('http') ? 'noreferrer' : undefined}
              >
                Open
              </a>
            </li>
          ))}
        </ol>
        <Link href="/dashboard/wallet?s=fund" className="btn btn-primary min-h-[44px] w-full no-underline sm:w-auto">
          Claim test ETH
        </Link>
      </section>

      <section className="card p-6 md:p-10">
        <h2 className="font-sans text-2xl tracking-wide text-paper">Ready when you are</h2>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
          Create an account, link WhatsApp or Telegram, and try a small test send.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link href="/signup" className="btn btn-primary min-h-[44px]">
            Create account
          </Link>
          <Link href="/docs" className="btn btn-ghost min-h-[44px]">
            Open guide
          </Link>
        </div>
      </section>
    </div>
  );
}
