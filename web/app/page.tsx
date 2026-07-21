import Link from 'next/link';
import { HowToCallBot } from '../components/HowToCallBot';

export default function HomePage() {
  return (
    <div className="fade-up space-y-16 md:space-y-24">
      <section className="hero-grid relative -mx-6 px-6 py-16 md:py-24">
        <div className="max-w-3xl">
          <p className="badge badge-gold mb-6">GIWA-first EVM</p>
          <h1 className="font-sans text-4xl font-semibold tracking-wide text-paper md:text-6xl md:leading-[1.08]">
            Send crypto on WhatsApp.
            <br />
            <span className="bg-gradient-to-r from-[#e8c45a] to-[#c4893f] bg-clip-text text-transparent">
              Only to people you trust.
            </span>
          </h1>
          <p className="mt-8 max-w-xl text-base leading-relaxed text-muted md:text-lg">
            Flizy is a WhatsApp wallet for real life. You manage trusted addresses and your unlock
            PIN here. On chat, you just send. A stolen phone cannot add a new destination.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/signup" className="btn btn-primary">
              Create free account
            </Link>
            <Link href="/how-it-works" className="btn btn-ghost">
              See how it works
            </Link>
          </div>
          <p className="mt-6 text-xs text-muted">
            No seed phrases in chat. No random drains to strangers.
          </p>
        </div>
      </section>

      {/* Primary guide: call bot + fund (single clean card) */}
      <HowToCallBot />

      <section className="space-y-6">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-gold">Also</p>
          <h2 className="mt-2 font-sans text-2xl tracking-wide text-paper">Why Flizy</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            {
              t: 'WhatsApp native',
              d: 'Link once from the dashboard. Chat the bot like any contact.',
            },
            {
              t: 'Trusted list',
              d: 'Only names you save can receive funds. Managed on the site or via flizy add wallet.',
            },
            {
              t: 'Your wallet sends',
              d: 'From address is your agent wallet. Fund it via faucet or GIWA bridge.',
            },
          ].map((item) => (
            <div key={item.t} className="card card-hover p-5">
              <h2 className="font-sans text-base tracking-wide text-paper">{item.t}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{item.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="grid md:grid-cols-2">
          <div className="border-b border-border p-8 md:border-b-0 md:border-r md:p-10">
            <p className="text-xs uppercase tracking-[0.18em] text-gold">Example on WhatsApp</p>
            <div className="mt-6 space-y-3 font-mono text-sm">
              <p className="text-muted">You</p>
              <p className="mono-box text-paper">flizy send 0.001 to nald</p>
              <p className="text-muted">Bot</p>
              <p className="mono-box text-lime">Pending. Reply confirm</p>
              <p className="mono-box text-paper">confirm</p>
              <p className="mono-box text-lime">https://sepolia-explorer.giwa.io/tx/0x…</p>
            </div>
          </div>
          <div className="flex flex-col justify-center p-8 md:p-10">
            <h2 className="font-sans text-2xl tracking-wide text-paper">Ready when you are</h2>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              Create an account, add one trusted address, link WhatsApp, and try a tiny test send on
              GIWA Sepolia.
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
