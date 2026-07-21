import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Security',
  description: 'Why Flizy only sends to trusted addresses managed on the site.',
};

export default function DocsPage() {
  return (
    <article className="fade-up mx-auto max-w-2xl space-y-8">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-gold">Security</p>
        <h1 className="mt-3 font-sans text-3xl tracking-wide text-paper md:text-4xl">
          Why trusted addresses
        </h1>
      </div>

      <p className="text-base leading-relaxed text-muted">
        Flizy only allows transfers to destinations you already trust. You manage that list on this
        site, not in WhatsApp. If someone steals your phone or hijacks chat, they still cannot add a
        new payout address from WhatsApp alone.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="card p-5">
          <h2 className="font-sans text-base text-lime">On the site</h2>
          <ul className="mt-3 space-y-2 text-sm text-muted">
            <li>Add or remove trusted wallets</li>
            <li>Set unlock PIN</li>
            <li>Link or re-link WhatsApp</li>
            <li>See agent wallet and credit</li>
          </ul>
        </div>
        <div className="card p-5">
          <h2 className="font-sans text-base text-gold">On WhatsApp</h2>
          <ul className="mt-3 space-y-2 text-sm text-muted">
            <li>Send to trusted names</li>
            <li>Confirm pending transfers</li>
            <li>Check balance and history</li>
            <li>Cannot rewrite trusted list</li>
          </ul>
        </div>
      </div>

      <p className="text-base leading-relaxed text-muted">
        If a send is rejected in chat, open the dashboard, confirm the name and address, then try
        again. Normal use stays simple. Changing the rules stays protected.
      </p>

      <div className="flex flex-wrap gap-3">
        <Link href="/dashboard" className="btn btn-primary">
          Open dashboard
        </Link>
        <Link href="/how-it-works" className="btn btn-ghost">
          How it works
        </Link>
      </div>
    </article>
  );
}
