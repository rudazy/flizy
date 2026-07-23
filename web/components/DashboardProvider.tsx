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
  setUnlockPin: (pin: string) => Promise<boolean>;
  setDailyLimit: (limit: number | null, password: string) => Promise<boolean>;
  explorerBase: string;
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [history, setHistory] = useState<TransferRow[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [holdings, setHoldings] = useState<HoldingsData | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError('');
    const res = await fetch('/api/dashboard');
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || 'Not logged in');
      setData(null);
      return;
    }
    setData(json);

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
  }, []);

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

  const generateLink = useCallback(async () => {
    setBusy('link');
    setMsg('');
    try {
      const res = await fetch('/api/link/create', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      setMsg('Link code ready. Tap Open WhatsApp to message the bot with the code.');
      await load();
      // Open bot chat with prefilled "flizy link CODE" when possible
      if (json.waDeepLink && typeof window !== 'undefined') {
        window.open(json.waDeepLink, '_blank', 'noopener,noreferrer');
      }
      return json as { code?: string; waDeepLink?: string; expiresAt?: string };
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
      return null;
    } finally {
      setBusy('');
    }
  }, [load]);

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
    async (pin: string) => {
      setBusy('pin');
      setMsg('');
      try {
        const res = await fetch('/api/pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed');
        setMsg(
          'Unlock PIN saved. On WhatsApp: flizy lock (no password) · flizy unlock then reply with this PIN or your account password.'
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
      explorerBase,
    ]
  );

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}
