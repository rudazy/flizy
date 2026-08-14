import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalArticle, LegalH } from '../../components/LegalArticle';
import { StructuredData, breadcrumbJsonLd } from '../../components/StructuredData';
import { pageMetadata } from '../../lib/seo';
import { siteOrigin } from '../../lib/siteOrigin';

export const metadata: Metadata = pageMetadata({
  title: 'Terms of service | Flizy',
  description:
    'What Flizy is, that it is testnet with no real-money value, account security, unclaimed escrow, uptime, prohibited use, and termination.',
  path: '/terms',
});

const UPDATED = '14 August 2026';

export default function TermsPage() {
  const origin = siteOrigin();

  return (
    <>
      <StructuredData
        data={breadcrumbJsonLd(origin, [
          { name: 'Home', path: '/' },
          { name: 'Terms', path: '/terms' },
        ])}
      />
      <LegalArticle
        eyebrow="Legal"
        title="Terms of service"
        updated={UPDATED}
        otherHref="/privacy"
        otherLabel="Privacy policy"
      >
        <section className="space-y-3">
          <LegalH id="what">What Flizy is</LegalH>
          <p>
            Flizy is a chat wallet. You create an account at{' '}
            <Link href="/" className="text-paper no-underline hover:text-lime">
              flizy.app
            </Link>
            , receive a Flizy wallet, save trusted destinations, and send or claim crypto from
            WhatsApp or Telegram. The site is for account, trusted list, PIN, invites, and
            swaps. Everyday send and claim run in chat. These terms govern use of the site and
            the bots.
          </p>
        </section>

        <section className="space-y-3">
          <LegalH id="testnet">Testnet, no real-money value</LegalH>
          <p>
            Flizy currently runs on GIWA Sepolia testnet. Balances, tokens, and credits you see
            have no cash value. Nothing here is an offer to sell, custody, or exchange real
            money or securities. If we move to a network with real value, we will say so on
            this site before that happens. Until then, treat every transfer as a test.
          </p>
        </section>

        <section className="space-y-3">
          <LegalH id="security">Your account</LegalH>
          <p>
            You are responsible for the email, password, unlock PIN, and chat apps linked to
            the account. Anyone who can open your WhatsApp or Telegram chat with the bot, or
            sign in on the site, can act as you. Keep those channels locked. Do not share link
            codes, claim URLs, or your password. Flizy will not ask for your password or PIN
            outside the product.
          </p>
          <p>
            Invite credit is a recorded count. It is not spendable and not redeemable for
            money.
          </p>
        </section>

        <section className="space-y-3">
          <LegalH id="escrow">Unclaimed escrow</LegalH>
          <p>
            A send to a phone, email, or platform identity that is not paid out immediately is
            held as a claim. The sender can cancel that hold until it is claimed. If it is
            claimed, the funds go to the claimer&apos;s Flizy wallet. If it is never claimed
            and never cancelled, it stays held; we are not obliged to hunt the recipient or to
            auto-return after a deadline unless the product later says otherwise. Do not send
            value you cannot afford to leave in a hold.
          </p>
        </section>

        <section className="space-y-3">
          <LegalH id="uptime">No uptime promise</LegalH>
          <p>
            We run Flizy as-is. The site, bots, RPC, and chain can be down, slow, or wrong.
            Confirms can fail. We do not guarantee that a command will land, that a claim will
            be available at a given moment, or that history will be complete. Testnet
            especially can reset or halt.
          </p>
        </section>

        <section className="space-y-3">
          <LegalH id="prohibited">Prohibited use</LegalH>
          <ul className="list-disc space-y-2 pl-5">
            <li>Crime, fraud, sanctions evasion, or money laundering.</li>
            <li>Attacking the site, bots, or other users (spam, credential stuffing, exploits).</li>
            <li>Using Flizy to message people who did not opt in, or to scrape identities.</li>
            <li>Impersonating Flizy or another user.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <LegalH id="terminate">Termination</LegalH>
          <p>
            We can stop serving an account that breaks these terms or that we have to cut off
            to protect other users or the service: refuse a login, a link, a send, or a claim.
            That is a product decision. It does not rewrite the chain. Confirmed transfers
            stay on GIWA Sepolia. If we stop serving an account that still has unclaimed
            escrow, we will try to cancel those holds back to the sender where the product
            already allows cancel. We do not owe damages for downtime or for a closed testnet
            account.
          </p>
        </section>

        <section className="space-y-3">
          <LegalH id="contact">Contact</LegalH>
          <p>
            Questions:{' '}
            <a
              href="https://x.com/Flizyapp"
              className="text-paper no-underline hover:text-lime"
              target="_blank"
              rel="noreferrer"
            >
              @Flizyapp
            </a>
            . Privacy details are in the{' '}
            <Link href="/privacy" className="text-paper no-underline hover:text-lime">
              privacy policy
            </Link>
            .
          </p>
        </section>

        <section className="space-y-3">
          <LegalH id="changes">Changes</LegalH>
          <p>
            We can update these terms by posting a new version on this page. The date at the
            top is the effective date. Keep using Flizy after that and you accept the new
            terms.
          </p>
        </section>
      </LegalArticle>
    </>
  );
}
