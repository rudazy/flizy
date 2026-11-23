'use client';

import Link from 'next/link';
import { useLocale } from './LocaleProvider';

/**
 * The pay link page when nothing matches: by name or code (/pay/{ref}) or by
 * Flizy number (/pay/c/{code}). A client component so it follows the
 * visitor's language like the rest of the page.
 */
export function PayNotFound({ by }: { by: 'name' | 'number' }) {
  const { t, locale } = useLocale();
  return (
    <div lang={locale} className="fade-up mx-auto max-w-md space-y-4">
      <h1 className="font-sans text-3xl tracking-wide text-paper">{t('pay.notFound')}</h1>
      <p className="text-sm text-muted">{t(by === 'name' ? 'pay.notFoundName' : 'pay.notFoundNumber')}</p>
      <Link href="/" className="text-sm text-lime no-underline hover:text-gold">
        {t('pay.home')}
      </Link>
    </div>
  );
}
