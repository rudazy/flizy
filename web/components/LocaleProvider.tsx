'use client';

/**
 * Client UI language. Guests use cookie/localStorage; signed-in users use
 * account.locale from the dashboard payload when available.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALES,
  LOCALE_LABELS,
  normalizeLocale,
  type LocaleCode,
} from '../lib/locale';
import { t as translate, type MessageKey } from '../lib/i18n/messages';

type LocaleContextValue = {
  locale: LocaleCode;
  setLocale: (code: LocaleCode) => void;
  t: (key: MessageKey, vars?: Record<string, string>) => string;
  labels: typeof LOCALE_LABELS;
  locales: typeof LOCALES;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function readStoredLocale(): LocaleCode {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  try {
    const fromCookie = document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${LOCALE_COOKIE}=`));
    if (fromCookie) {
      return normalizeLocale(decodeURIComponent(fromCookie.split('=')[1] || ''));
    }
    const ls = localStorage.getItem(LOCALE_COOKIE);
    if (ls) return normalizeLocale(ls);
  } catch {
    /* ignore */
  }
  return DEFAULT_LOCALE;
}

function persistLocale(code: LocaleCode) {
  try {
    localStorage.setItem(LOCALE_COOKIE, code);
    const maxAge = 60 * 60 * 24 * 365;
    document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(code)}; path=/; max-age=${maxAge}; samesite=lax`;
  } catch {
    /* ignore */
  }
}

export function LocaleProvider({
  children,
  accountLocale,
}: {
  children: ReactNode;
  /** When dashboard is loaded, prefer the account preference */
  accountLocale?: string | null;
}) {
  const [locale, setLocaleState] = useState<LocaleCode>(DEFAULT_LOCALE);

  useEffect(() => {
    setLocaleState(readStoredLocale());
  }, []);

  useEffect(() => {
    if (accountLocale) {
      const n = normalizeLocale(accountLocale);
      setLocaleState(n);
      persistLocale(n);
    }
  }, [accountLocale]);

  const setLocale = useCallback((code: LocaleCode) => {
    const n = normalizeLocale(code);
    setLocaleState(n);
    persistLocale(n);
  }, []);

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string>) => translate(locale, key, vars),
    [locale]
  );

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t,
      labels: LOCALE_LABELS,
      locales: LOCALES,
    }),
    [locale, setLocale, t]
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider');
  return ctx;
}

/** Compact language select used on signup / account */
export function LanguageSelect({
  value,
  onChange,
  id = 'locale',
  className = '',
}: {
  value: LocaleCode;
  onChange: (code: LocaleCode) => void;
  id?: string;
  className?: string;
}) {
  return (
    <select
      id={id}
      className={`input ${className}`.trim()}
      value={value}
      onChange={(e) => onChange(normalizeLocale(e.target.value))}
    >
      {LOCALES.map((code) => (
        <option key={code} value={code}>
          {LOCALE_LABELS[code]}
        </option>
      ))}
    </select>
  );
}
