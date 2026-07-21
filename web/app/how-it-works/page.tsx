import type { Metadata } from 'next';
import Link from 'next/link';
import { HowToCallBot } from '../../components/HowToCallBot';

export const metadata: Metadata = {
  title: 'How to use Flizy',
  description:
    'Use Flizy from any country: create an account, fund your agent wallet, open the bot from the dashboard, send to trusted names.',
};

export default function HowItWorksPage() {
  return (
    <div className="fade-up mx-auto max-w-3xl space-y-8">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-gold">Guide</p>
        <h1 className="mt-3 font-sans text-3xl tracking-wide text-paper sm:text-4xl">
          How to use Flizy
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted sm:text-base">
          One clean guide for every country. Setup on the website. Everyday sends on WhatsApp.
        </p>
      </div>

      <HowToCallBot />

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
