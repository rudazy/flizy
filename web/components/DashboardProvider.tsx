'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  ActivityItem,
  DashboardData,
  HoldingsData,
  TransferRow,
} from '../lib/dashboardTypes';
import { useLocale } from './LocaleProvider';
import { normalizeLocale, type LocaleCode } from '../lib/locale';

type DashboardContextValue = {
  data: DashboardData | null;
  history: TransferRow[];
  activity: ActivityItem[];
  holdings: HoldingsData | null;
  error: string;
  msg: string;
  setMsg: (m: string) => void;
  busy: string;
  setBusy: (b: string) => void;
  refreshing: boolean;
  load: () => Promise<void>;
  refreshAll: () => Promise<void>;
  generateLink: () => Promise<{ code?: string; waDeepLink?: string; expiresAt?: string } | null | void>;
  addTrusted: (input: {
    address: string;
    label: string;
    password: string;
  }) => Promise<boolean>;
  removeTrusted: (address: string, password: string) => Promise<boolean>;
  setUnlockPin: (pin: string, password: string) => Promise<boolean>;
  setDailyLimit: (limit: number | null, password: string) => Promise<boolean>;
  setUsername: (username: string) => Promise<boolean>;
  setAccountLocale: (locale: LocaleCode) => Promise<boolean>;
  explorerBase: string;
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const { setLocale } = useLocale();
  const [data, setData] = useState<DashboardData | null>(null);
  const [history, setHistory] = useState<TransferRow[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [holdings, setHoldings] = useState<HoldingsData | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  /**
   * Account, trusted list and link code only. Split out from load() because the
   * link code has to be re-read on its own: it is single use and can be spent in
   * a chat app while this tab sits open, and re-reading balances and on-chain
   * holdings every time the tab regains focus would be wasteful.
   */
  const loadAccount = useCallback(async () => {
    const res = await fetch('/api/dashboard');
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || 'Not logged in');
      setData(null);
      return false;
    }
    setError('');
    setData(json);
    if (json?.account?.locale) {
      setLocale(normalizeLocale(json.account.locale));
    }
    return true;
  }, [setLocale]);

  const load = useCallback(async () => {
    setError('');
    const ok = await loadAccount();
    if (!ok) return;

    const [histRes, holdRes] = await Promise.all([
      fetch('/api/history'),
      fetch('/api/holdings'),
    ]);
    if (histRes.ok) {
      const h = await histRes.json();
      setHistory(h.transfers || []);
      setActivity(h.activity || []);
    }
    if (holdRes.ok) {
      const ho = await holdRes.json();
      setHoldings(ho);
    }
  }, [loadAccount]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    setMsg('');
    try {
      await load();
      setMsg('Balances and history refreshed.');
    } catch {
      setMsg('Could not refresh. Try again.');
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Re-read the account whenever this tab comes back to the front.
   *
   * Linking always leaves the page: you go to WhatsApp or Telegram, spend the
   * code there, and come back. The code on screen is single use, so once it is
   * spent the buttons beside it are pointing at something dead while still
   * looking live. Coming back to the tab is exactly the moment to find out.
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const recheck = () => {
      if (document.visibilityState === 'visible') loadAccount();
    };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
    };
  }, [loadAccount]);

  const generateLink = useCallback(async () => {
    setBusy('link');
    setMsg('');
    try {
      const res = await fetch('/api/link/create', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      // Deliberately does not open a chat app. This used to open WhatsApp by
      // itself, which chose the channel for the user: the code is single use, so
      // sending that prefilled message spent it, and the Telegram button beside
      // it was then pointing at a dead code. Let the user pick.
      setMsg('Link code ready. It works once, on whichever chat app you open first.');
      await loadAccount();
      return json as { code?: string; waDeepLink?: string; expiresAt?: string };
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
      return null;
    } finally {
      setBusy('');
    }
  }, [loadAccount]);

  const addTrusted = useCallback(
    async (input: { address: string; label: string; password: string }) => {
      setBusy('trusted');
      setMsg('');
      try {
        const res = await fetch('/api/trusted', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: input.address.trim(),
            label: input.label.trim(),
            password: input.password,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed');
        setMsg(`Saved trusted wallet "${input.label.trim() || input.address}".`);
        await load();
        return true;
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Failed');
        return false;
      } finally {
        setBusy('');
      }
    },
    [load]
  );

  const removeTrusted = useCallback(
    async (address: string, password: string) => {
      setBusy('remove');
      setMsg('');
      try {
        const res = await fetch('/api/trusted', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, password }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed');
        setMsg('Trusted wallet removed.');
        await load();
        return true;
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Failed');
        return false;
      } finally {
        setBusy('');
      }
    },
    [load]
  );

  const setUnlockPin = useCallback(
    async (pin: string, password: string) => {
      setBusy('pin');
      setMsg('');
      try {
        const res = await fetch('/api/pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin, password }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed');
        setMsg(
          'Unlock PIN saved. On WhatsApp: flizy lock (no password) · flizy unlock then reply with this PIN or your account password. Any unlock block from wrong attempts is cleared.'
        );
        await load();
        return true;
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Failed');
        return false;
      } finally {
        setBusy('');
      }
    },
    [load]
  );

  const setDailyLimit = useCallback(
    async (limit: number | null, password: string) => {
      setBusy('limit');
      setMsg('');
      try {
        const res = await fetch('/api/limits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ daily_send_limit_eth: limit, password }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed');
        setMsg(
          limit == null
            ? 'Daily limit cleared (app default).'
            : `Daily send limit set to ${limit} ETH (UTC day).`
        );
        await load();
        return true;
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Failed');
        return false;
      } finally {
        setBusy('');
      }
    },
    [load]
  );

  const setUsername = useCallback(
    async (username: string) => {
      setBusy('username');
      setMsg('');
      try {
        const res = await fetch('/api/account/username', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed');
        const u = json.account?.username ? `@${json.account.username}` : 'Username';
        setMsg(`${u} saved. Claimed-by notifications will use this label.`);
        await loadAccount();
        return true;
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Failed');
        return false;
      } finally {
        setBusy('');
      }
    },
    [loadAccount]
  );

  const setAccountLocale = useCallback(
    async (locale: LocaleCode) => {
      setBusy('locale');
      setMsg('');
      try {
        const res = await fetch('/api/account/locale', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed');
        setLocale(normalizeLocale(json.account?.locale || locale));
        setMsg('Language saved.');
        await loadAccount();
        return true;
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Failed');
        return false;
      } finally {
        setBusy('');
      }
    },
    [loadAccount, setLocale]
  );

  const explorerBase =
    holdings?.holdings?.chain?.explorerBaseUrl || 'https://sepolia-explorer.giwa.io';

  const value = useMemo(
    () => ({
      data,
      history,
      activity,
      holdings,
      error,
      msg,
      setMsg,
      busy,
      setBusy,
      refreshing,
      load,
      refreshAll,
      generateLink,
      addTrusted,
      removeTrusted,
      setUnlockPin,
      setDailyLimit,
      setUsername,
      setAccountLocale,
      explorerBase,
    }),
    [
      data,
      history,
      activity,
      holdings,
      error,
      msg,
      busy,
      refreshing,
      load,
      refreshAll,
      generateLink,
      addTrusted,
      removeTrusted,
      setUnlockPin,
      setDailyLimit,
      setUsername,
      setAccountLocale,
      explorerBase,
    ]
  );

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}
