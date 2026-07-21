import type { Metadata } from 'next';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/SiteFooter';
import './globals.css';

function siteOrigin() {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'http://localhost:3000';
  try {
    return new URL(raw).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

const origin = siteOrigin();

export const metadata: Metadata = {
  metadataBase: new URL(origin),
  title: {
    default: 'Flizy | WhatsApp wallet, trusted sends',
    template: '%s | Flizy',
  },
  description:
    'Send crypto from WhatsApp to people you already trust. Manage trusted addresses and unlock PIN on the site. GIWA-first EVM.',
  applicationName: 'Flizy',
  keywords: ['Flizy', 'WhatsApp', 'crypto', 'wallet', 'GIWA', 'trusted addresses', 'EVM'],
  authors: [{ name: 'Flizy' }],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: origin,
    siteName: 'Flizy',
    title: 'Flizy | Send crypto on WhatsApp. Not to strangers.',
    description:
      'WhatsApp-native wallet. Trusted destinations on the site. Unlock with a PIN. Built for GIWA and EVM.',
    images: [
      {
        url: '/og.jpg',
        width: 1200,
        height: 630,
        alt: 'Flizy: Send crypto on WhatsApp',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Flizy | WhatsApp wallet, trusted sends',
    description: 'Send crypto from WhatsApp only to addresses you already trust.',
    images: ['/og.jpg'],
  },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icon-512.jpg', type: 'image/jpeg', sizes: '512x512' },
    ],
    apple: [{ url: '/apple-touch-icon.jpg', sizes: '180x180' }],
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="page-shell font-mono antialiased">
        <SiteHeader />
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-6 py-12 md:py-16">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
