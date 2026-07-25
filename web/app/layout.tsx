import type { Metadata, Viewport } from 'next';
import { AppChrome } from '../components/AppChrome';
import './globals.css';

function siteOrigin() {
  const raw =
    process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://flizy.vercel.app';
  try {
    return new URL(raw).origin;
  } catch {
    return 'https://flizy.vercel.app';
  }
}

const origin = siteOrigin();

export const metadata: Metadata = {
  metadataBase: new URL(origin),
  title: {
    default: 'Flizy | Chat wallet for WhatsApp and Telegram, trusted sends',
    template: '%s | Flizy',
  },
  description:
    'Send crypto from WhatsApp or Telegram to people you already trust. One account, both chats. Manage trusted addresses and unlock PIN on the site. GIWA-first EVM.',
  applicationName: 'Flizy',
  keywords: [
    'Flizy',
    'WhatsApp',
    'Telegram',
    'crypto',
    'wallet',
    'GIWA',
    'trusted addresses',
    'EVM',
    'PWA',
  ],
  authors: [{ name: 'Flizy' }],
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Flizy',
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: origin,
    siteName: 'Flizy',
    title: 'Flizy | Send crypto from your chat app. Not to strangers.',
    description:
      'Chat-native wallet for WhatsApp and Telegram. Trusted destinations on the site. Unlock with a PIN. Built for GIWA and EVM.',
    images: [
      {
        url: '/og.jpg',
        width: 1200,
        height: 630,
        alt: 'Flizy: Send crypto from WhatsApp or Telegram',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Flizy | Chat wallet for WhatsApp and Telegram, trusted sends',
    description:
      'Send crypto from WhatsApp or Telegram, only to addresses you already trust.',
    images: ['/og.jpg'],
  },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
      { url: '/icon-512.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: [{ url: '/apple-touch-icon.jpg', sizes: '180x180' }],
  },
  robots: { index: true, follow: true },
  other: {
    'mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b0a09',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="page-shell font-mono antialiased">
        <AppChrome>{children}</AppChrome>
      </body>
    </html>
  );
}
