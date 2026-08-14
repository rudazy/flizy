import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalArticle, LegalH } from '../../components/LegalArticle';
import { StructuredData, breadcrumbJsonLd } from '../../components/StructuredData';
import { pageMetadata } from '../../lib/seo';
import { siteOrigin } from '../../lib/siteOrigin';

export const metadata: Metadata = pageMetadata({
  title: 'Privacy policy | Flizy',
  description:
    'What Flizy collects, why we hold it, who it is shared with, how long we keep it, and how to ask us to delete your account.',
  path: '/privacy',
});

const UPDATED = '14 August 2026';

export default function PrivacyPage() {
  const origin = siteOrigin();

  return (
    <>
      <StructuredData
        data={breadcrumbJsonLd(origin, [
          { name: 'Home', path: '/' },
          { name: 'Privacy', path: '/privacy' },
        ])}
      />
      <LegalArticle
        eyebrow="Legal"
        title="Privacy policy"
        updated={UPDATED}
        otherHref="/terms"
        otherLabel="Terms of service"
      >
        <section className="space-y-3">
          <LegalH id="who">Who we are</LegalH>
          <p>
            Flizy is a chat wallet at{' '}
            <Link href="/" className="text-paper no-underline hover:text-lime">
              flizy.app
            </Link>
            . You create an account on the site, then send and receive crypto from WhatsApp or
            Telegram to people you already trust. This policy describes personal data we hold
            when you use the site, the bots, and linked platforms.
          </p>
        </section>

        <section className="space-y-3">
          <LegalH id="collect">What we collect</LegalH>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="text-paper">Email and verification codes.</span> Registration
              email, optional extra emails, and short-lived codes that prove you control that
              inbox.
            </li>
            <li>
              <span className="text-paper">Phone number.</span> Only when you prove it in
              WhatsApp or Telegram (contact share or equivalent). We do not accept a typed
              number as proof.
            </li>
            <li>
              <span className="text-paper">Platform identities.</span> If you link GitHub,
              Discord, X, or TikTok: the immutable user ID (routing key) and the display
              handle. We do not read your posts, messages, or followers on those platforms.
            </li>
            <li>
              <span className="text-paper">Flizy username and display name.</span> Username is
              your public invite and pay identity. Display name is optional.
            </li>
            <li>
              <span className="text-paper">Wallet and history.</span> Your Flizy agent-wallet
              address, trusted destination addresses you save, send / claim / swap records, and
              related transaction hashes.
            </li>
            <li>
              <span className="text-paper">Session cookies.</span> A logged-in session cookie
              on the site. If you open an invite or a claim that carries an invite, a short
              invite cookie so signup can attribute you once.
            </li>
            <li>
              <span className="text-paper">Chat link.</span> One-time link codes and the
              channel bind (WhatsApp or Telegram chat id) after you redeem a code.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <LegalH id="tiktok">TikTok data</LegalH>
          <p>
            When you choose to link TikTok, Flizy requests the TikTok Login Kit scope{' '}
            <span className="text-paper">user.info.basic</span>. From that grant we read only:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>your TikTok user ID, stored as the routing key for claims sent to that account</li>
            <li>your TikTok display handle, stored for display on Flizy</li>
          </ul>
          <p>
            We do not post to TikTok. We do not read your videos, comments, likes, DMs, or
            follower lists. We do not use TikTok data to advertise. Unlinking TikTok on Account
            removes that bind from your Flizy account. Pending claims already addressed to that
            TikTok user ID stay addressed to that ID until claimed or cancelled.
          </p>
        </section>

        <section className="space-y-3">
          <LegalH id="why">Why we hold it</LegalH>
          <ul className="list-disc space-y-2 pl-5">
            <li>Create and sign you into the account.</li>
            <li>Prove email and phone so claims pay out to the right person.</li>
            <li>Route a send or claim to a GitHub, Discord, X, or TikTok identity you linked.</li>
            <li>Keep trusted destinations and an unlock PIN under your control.</li>
            <li>Attribute an invite once, and count it only after onboarding, a verified phone, and a confirmed Flizy transaction.</li>
            <li>Operate the product, debug failures, and stop abuse.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <LegalH id="share">Who it is shared with</LegalH>
          <p>
            We pass account data only to the services that run Flizy: Supabase (database) and
            our email sender for verification codes. We do not sell it. We do not use
            advertising pixels.
          </p>
        </section>

        <section className="space-y-3">
          <LegalH id="keep">How long we keep it</LegalH>
          <ul className="list-disc space-y-2 pl-5">
            <li>Verification codes expire in minutes and are then useless.</li>
            <li>Session cookies last until you sign out or they expire.</li>
            <li>Invite cookies last up to 14 days, or until they are used at signup.</li>
            <li>Account, username, trusted addresses, and history stay while the account exists.</li>
            <li>
              A phone that has already produced an invite credit is remembered so the same
              number cannot mint a second credit after unlink. That record is not a live bind.
            </li>
            <li>On-chain records last as long as the chain does. We cannot erase them.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <LegalH id="delete">Deleting your account</LegalH>
          <p>
            You can unlink WhatsApp, Telegram, GitHub, Discord, X, and TikTok yourself on
            Account. You can remove extra emails and trusted addresses there too.
          </p>
          <p>
            There is no self-serve full-account delete in the app today. Message us on X at{' '}
            <a
              href="https://x.com/Flizyapp"
              className="text-paper no-underline hover:text-lime"
              target="_blank"
              rel="noreferrer"
            >
              @Flizyapp
            </a>{' '}
            from an account you can tie to the Flizy email. We will delete or irreversibly
            anonymize account records we control (profile, emails, phone binds, platform IDs,
            sessions, invite attribution we can safely drop). We will not delete another
            person&apos;s data. We cannot delete confirmed chain transactions. If you have
            pending escrow, say so; we will cancel unclaimed holds back to the sender where
            the product already allows cancel.
          </p>
        </section>

        <section className="space-y-3">
          <LegalH id="contact">Contact</LegalH>
          <p>
            Privacy requests:{' '}
            <a
              href="https://x.com/Flizyapp"
              className="text-paper no-underline hover:text-lime"
              target="_blank"
              rel="noreferrer"
            >
              @Flizyapp
            </a>
            .
          </p>
        </section>

        <section className="space-y-3">
          <LegalH id="changes">Changes</LegalH>
          <p>
            If this policy changes in a way that affects how we use personal data, we will
            update this page and the date above. Continued use after that date is acceptance of
            the updated policy.
          </p>
        </section>
      </LegalArticle>
    </>
  );
}
