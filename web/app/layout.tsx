import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { Analytics } from '../components/Analytics';
import { AppChrome } from '../components/AppChrome';
import { JsonLd } from '../components/JsonLd';
import { LocaleProvider } from '../components/LocaleProvider';
import { OG_IMAGE } from '../lib/seo';
import './globals.css';

function siteOrigin() {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://flizy.app';
  try {
    return new URL(raw).origin;
  } catch {
    return 'https://flizy.app';
  }
}

const origin = siteOrigin();

const SITE_TITLE = 'Flizy — Send crypto from WhatsApp & Telegram';
const SITE_DESCRIPTION =
  'Chat wallet for WhatsApp and Telegram. One account, both chats. Send only to people you already trust. Manage addresses and unlock PIN on the site. GIWA-first EVM.';

export const metadata: Metadata = {
  metadataBase: new URL(origin),
  title: {
    default: SITE_TITLE,
    template: '%s | Flizy',
  },
  description: SITE_DESCRIPTION,
  applicationName: 'Flizy',
  keywords: [
    'Flizy',
    'WhatsApp wallet',
    'Telegram wallet',
    'crypto chat wallet',
    'trusted addresses',
    'send crypto WhatsApp',
    'send crypto Telegram',
    'GIWA',
    'EVM wallet',
    'PWA',
  ],
  authors: [{ name: 'Flizy' }],
  alternates: {
    canonical: './',
  },
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
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    site: '@Flizyapp',
    creator: '@Flizyapp',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE.url],
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
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="page-shell font-mono antialiased">
        <JsonLd />
        <Analytics />
        <LocaleProvider>
          <AppChrome>{children}</AppChrome>
        </LocaleProvider>
      </body>
    </html>
  );
}
