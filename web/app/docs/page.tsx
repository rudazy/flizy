import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Docs — Security & commands',
  description:
    'Why Flizy only sends to trusted people, and the full chat command list for WhatsApp and Telegram.',
};

const CMD_GROUPS: Array<{
  title: string;
  blurb: string;
  rows: Array<{ wa: string; tg: string; meaning: string }>;
}> = [
  {
    title: 'Pay someone',
    blurb: 'Nothing leaves until you confirm. Trusted names are managed on the site only.',
    rows: [
      {
        wa: 'flizy send 0.01 to john',
        tg: '/send 0.01 to john',
        meaning: 'Pay a trusted name you saved on the site',
      },
      {
        wa: 'flizy send 0.01 to 2348012345678',
        tg: '/send 0.01 to 2348012345678',
        meaning: 'Hold for a phone until they claim (you can cancel until then)',
      },
      {
        wa: 'flizy send 0.01 to @user on github',
        tg: '/send 0.01 to @user on github',
        meaning: 'Hold for that GitHub account until they claim',
      },
      {
        wa: 'flizy send 10 FLZ to john',
        tg: '/send 10 FLZ to john',
        meaning: 'Send FLZ to a trusted name (when you hold FLZ)',
      },
      { wa: 'confirm', tg: 'confirm or tap Confirm', meaning: 'Approve the plan' },
      { wa: 'cancel', tg: 'cancel', meaning: 'Abort the pending plan' },
    ],
  },
  {
    title: 'Receive & ask',
    blurb: 'Claims and requests use phone or linked platforms — not random addresses from chat.',
    rows: [
      {
        wa: 'flizy claim',
        tg: '/claim',
        meaning: 'Receive money held for your phone or linked GitHub',
      },
      {
        wa: 'flizy cancel claims',
        tg: '/claims or cancel claims',
        meaning: 'Cancel holds you sent (while still pending)',
      },
      {
        wa: 'flizy request 0.01 from 234…',
        tg: '/request 0.01 from 234…',
        meaning: 'Ask someone for money',
      },
      { wa: 'flizy pay', tg: '/pay', meaning: 'Pay a request addressed to you' },
      {
        wa: 'flizy requests',
        tg: '/requests',
        meaning: 'See or cancel open requests you made',
      },
      {
        wa: '—',
        tg: '/phone',
        meaning: 'Telegram only: share your number once so phone claims can find you',
      },
    ],
  },
  {
    title: 'Account & safety',
    blurb: 'Link once. Lock freezes this chat only — your other apps stay as they are.',
    rows: [
      {
        wa: 'flizy link CODE',
        tg: '/link CODE',
        meaning: 'Connect this chat to your site account (code from dashboard)',
      },
      { wa: 'flizy me', tg: '/me', meaning: 'Your linked account summary' },
      { wa: 'flizy balance', tg: '/balance', meaning: 'What you have' },
      { wa: 'flizy history', tg: '/history', meaning: 'Recent activity' },
      {
        wa: 'flizy deposit',
        tg: '/deposit',
        meaning: 'How to add funds (full steps on the dashboard)',
      },
      { wa: 'flizy lock', tg: '/lock', meaning: 'Freeze Flizy on this chat' },
      {
        wa: 'flizy unlock',
        tg: '/unlock',
        meaning: 'Unlock with your PIN or account password',
      },
      { wa: 'flizy help', tg: '/help', meaning: 'Short guide in chat' },
    ],
  },
  {
    title: 'Optional — trade FLZ',
    blurb: 'Power tools. Fees appear in the plan before you confirm. Liquidity is site-only.',
    rows: [
      { wa: 'flizy buy 0.01 FLZ', tg: '/buy 0.01 FLZ', meaning: 'Spend ETH for FLZ' },
      { wa: 'flizy sell 10 FLZ', tg: '/sell 10 FLZ', meaning: 'Sell FLZ for ETH' },
      {
        wa: 'flizy swap 0.01 ETH for FLZ',
        tg: '/swap 0.01 ETH for FLZ',
        meaning: 'Same idea, explicit pair',
      },
      { wa: 'flizy price FLZ', tg: '/price FLZ', meaning: 'Current FLZ price' },
    ],
  },
];

export default function DocsPage() {
  return (
    <article className="fade-up mx-auto max-w-3xl space-y-12">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-gold">Docs</p>
        <h1 className="mt-3 font-sans text-3xl tracking-wide text-paper md:text-4xl">
          Security &amp; full commands
        </h1>
        <p className="mt-4 text-base leading-relaxed text-muted">
          Flizy makes sending money feel like sending a message. Chat is the everyday surface;
          this page is the full context when you want every command.
        </p>
      </div>

      {/* Security */}
      <section className="space-y-4">
        <h2 className="font-sans text-xl tracking-wide text-paper">Why trusted people</h2>
        <p className="text-base leading-relaxed text-muted">
          Flizy only allows transfers to destinations you already approved on the site — never by
          adding a new payout address from WhatsApp or Telegram alone. If someone steals your phone
          or hijacks a chat, they still cannot rewrite who you can pay.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="card p-5">
            <h3 className="font-sans text-base text-lime">On the site</h3>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li>Add or remove trusted people</li>
              <li>Set unlock PIN and daily limits</li>
              <li>Link chat apps and platforms (e.g. GitHub)</li>
              <li>Set Flizy @username and language</li>
              <li>See balance, history, pending claims</li>
            </ul>
          </div>
          <div className="card p-5">
            <h3 className="font-sans text-base text-gold">On WhatsApp or Telegram</h3>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li>Send, request, claim, pay</li>
              <li>Confirm or cancel a plan</li>
              <li>Check balance and history</li>
              <li>Lock / unlock this chat</li>
              <li>Cannot rewrite trusted list from chat</li>
            </ul>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-muted">
          One engine enforces the rules on every channel. We hide network plumbing (RPC, gas,
          chain IDs) unless you dig into fund or power tools — money should feel like messaging.
        </p>
      </section>

      {/* Commands */}
      <section className="space-y-8">
        <div>
          <h2 className="font-sans text-xl tracking-wide text-paper">All chat commands</h2>
          <p className="mt-2 text-sm text-muted">
            WhatsApp: prefix with <span className="text-paper">flizy</span>. Telegram: use a slash
            or the same words. Type <span className="text-paper">flizy help</span> or{' '}
            <span className="text-paper">/help</span> in chat for a short everyday guide.
          </p>
        </div>

        {CMD_GROUPS.map((group) => (
          <div key={group.title} className="space-y-3">
            <div>
              <h3 className="font-sans text-base tracking-wide text-lime">{group.title}</h3>
              <p className="mt-1 text-xs text-muted">{group.blurb}</p>
            </div>
            <div className="overflow-x-auto rounded border border-border">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface text-xs uppercase tracking-wide text-muted">
                    <th className="px-3 py-2 font-normal">WhatsApp</th>
                    <th className="px-3 py-2 font-normal">Telegram</th>
                    <th className="px-3 py-2 font-normal">What it does</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={row.wa + row.tg} className="border-b border-border last:border-0">
                      <td className="px-3 py-2.5 font-mono text-xs text-paper">{row.wa}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-paper">{row.tg}</td>
                      <td className="px-3 py-2.5 text-muted">{row.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="font-sans text-base text-paper">Setup in three steps</h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
          <li>Create an account and set your @username on the site</li>
          <li>Add trusted people, unlock PIN, link WhatsApp or Telegram (and GitHub if you want claims)</li>
          <li>
            In chat: send → confirm. Full fund steps live under Wallet → Fund on the dashboard
          </li>
        </ol>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/dashboard" className="btn btn-primary">
          Open dashboard
        </Link>
        <Link href="/how-it-works" className="btn btn-ghost">
          How it works
        </Link>
        <Link href="/signup" className="btn btn-ghost">
          Create account
        </Link>
      </div>
    </article>
  );
}
