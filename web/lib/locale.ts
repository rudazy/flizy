/**
 * UI language codes for Flizy web.
 * @username stays ASCII; display names and UI copy may be any locale.
 */

export const LOCALES = ['en', 'ko', 'zh'] as const;
export type LocaleCode = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: LocaleCode = 'en';

export const LOCALE_LABELS: Record<LocaleCode, string> = {
  en: 'English',
  ko: '한국어',
  zh: '中文',
};

export function normalizeLocale(raw: unknown): LocaleCode {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (s === 'en' || s.startsWith('en-')) return 'en';
  if (s === 'ko' || s.startsWith('ko-')) return 'ko';
  if (s === 'zh' || s.startsWith('zh-')) return 'zh';
  return DEFAULT_LOCALE;
}

export function isLocaleCode(raw: unknown): raw is LocaleCode {
  return (LOCALES as readonly string[]).includes(String(raw || '').trim().toLowerCase());
}

/** Cookie for guests (signup / login / marketing) before account exists. */
export const LOCALE_COOKIE = 'flizy_locale';
