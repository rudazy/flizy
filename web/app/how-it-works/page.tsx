import type { Metadata } from 'next';
import Link from 'next/link';
import { HowToCallBot } from '../../components/HowToCallBot';
import {
  StructuredData,
  breadcrumbJsonLd,
  faqJsonLd,
} from '../../components/StructuredData';
import { FLIZY_FAQ } from '../../lib/flizyFaq';
import { pageMetadata } from '../../lib/seo';
import { siteOrigin } from '../../lib/siteOrigin';

export const metadata: Metadata = pageMetadata({
  title: 'How Flizy works — send crypto on WhatsApp & Telegram',
  description:
    'Set up Flizy once on the web, then send crypto from WhatsApp or Telegram to people you trust. Account, funding, link code, and everyday chat sends.',
  path: '/how-it-works',
});

export default function HowItWorksPage() {
  const origin = siteOrigin();

  return (
    <div className="fade-up mx-auto max-w-3xl space-y-8">
      <StructuredData
        data={breadcrumbJsonLd(origin, [
          { name: 'Home', path: '/' },
          { name: 'How it works', path: '/how-it-works' },
        ])}
      />
      <StructuredData data={faqJsonLd(FLIZY_FAQ)} />

      <nav className="text-xs text-muted" aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1.5">
          <li>
            <Link href="/" className="text-muted no-underline hover:text-lime">
              Home
            </Link>
          </li>
          <li aria-hidden className="text-border">
            /
          </li>
          <li className="text-paper">How it works</li>
        </ol>
      </nav>

      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-gold">Guide</p>
        <h1 className="mt-3 font-sans text-3xl tracking-wide text-paper sm:text-4xl">
          How to use Flizy
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted sm:text-base">
          One clean guide for every country. Setup on the website. Everyday sends on WhatsApp or
          Telegram, whichever you already use.
        </p>
      </div>

      <HowToCallBot />

      <section className="space-y-4" aria-labelledby="faq-heading">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-gold">FAQ</p>
          <h2 id="faq-heading" className="mt-2 font-sans text-2xl tracking-wide text-paper">
            Common questions
          </h2>
        </div>
        <dl className="space-y-3">
          {FLIZY_FAQ.map((item) => (
            <div
              key={item.question}
              className="rounded-md border border-border bg-ink/40 px-4 py-3"
            >
              <dt className="font-sans text-sm tracking-wide text-paper">{item.question}</dt>
              <dd className="mt-2 text-xs leading-relaxed text-muted sm:text-sm">{item.answer}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Link href="/signup" className="btn btn-primary w-full justify-center sm:w-auto">
          Create account
        </Link>
        <Link href="/docs" className="btn btn-ghost w-full justify-center sm:w-auto">
          Security
        </Link>
      </div>
    </div>
  );
}
