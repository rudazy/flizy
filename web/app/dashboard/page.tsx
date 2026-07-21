'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CopyButton } from '../../components/CopyButton';
import { AccordionSection } from '../../components/Accordion';

type DashboardData = {
  account: {
    id: string;
    email?: string | null;
    display_name?: string | null;
    agent_wallet_address?: string | null;
    balance_eth?: number | string;
    has_pin: boolean;
  };
  trusted: Array<{ address: string; label: string }>;
  link?: { code: string; waDeepLink: string; expiresAt: string } | null;
};

type TransferRow = {
  id: string;
  amount_eth: string | number;
  to_address: string;
  status: string;
  tx_hash?: string | null;
  created_at: string;
};

type HoldingsData = {
  credit: number | string;
  agent_wallet_address?: string | null;
  holdings: {
    chain: { name: string; chainId: number; explorerBaseUrl: string };
    native: { symbol: string; balance: string } | null;
    tokens: Array<{ symbol: string; address: string | null; balance: string | null; error?: string }>;
    note?: string | null;
  };
};

function shortAddr(addr: string) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'wallet', label: 'Wallet & holdings' },
  { id: 'trusted', label: 'Trusted wallets' },
  { id: 'whatsapp', label: 'WhatsApp link' },
  { id: 'pin', label: 'Unlock PIN' },
  { id: 'history', label: 'History' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export default function DashboardPage() {
  const search = useSearchParams();
  const welcome = search.get('welcome') === '1';

  const [data, setData] = useState<DashboardData | null>(null);
  const [history, setHistory] = useState<TransferRow[]>([]);
  const [holdings, setHoldings] = useState<HoldingsData | null>(null);
  const [error, setError] = useState('');
  const [addr, setAddr] = useState('');
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [removePassword, setRemovePassword] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<SectionId>('overview');
  const [jump, setJump] = useState<SectionId | ''>('');
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
    }
    if (holdRes.ok) {
      const ho = await holdRes.json();
      setHoldings(ho);
    }
  }, []);

  async function refreshAll() {
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
  }

  useEffect(() => {
    load();
  }, [load]);

  const checklist = useMemo(() => {
    if (!data) return [];
    return [
      { done: true, title: 'Account created', body: data.account.email || 'Signed in' },
      {
        done: Boolean(data.account.agent_wallet_address),
        title: 'Agent wallet ready',
        body: data.account.agent_wallet_address
          ? shortAddr(data.account.agent_wallet_address)
          : 'Generating...',
      },
      {
        done: data.trusted.length > 0,
        title: 'Trusted wallet added',
        body: data.trusted.length ? `${data.trusted.length} saved` : 'Required for sends',
      },
      {
        done: data.account.has_pin,
        title: 'Unlock PIN',
        body: data.account.has_pin ? 'Set' : 'Recommended',
      },
      {
        done: Boolean(data.link),
        title: 'WhatsApp link code',
        body: data.link ? `Code ${data.link.code}` : 'Generate when ready',
      },
    ];
  }, [data]);

  function onToggle(id: string) {
    setOpen((prev) => (prev === id ? prev : (id as SectionId)));
  }

  function onJumpChange(value: string) {
    setJump(value as SectionId);
    if (value) setOpen(value as SectionId);
  }

  async function generateLink() {
    setBusy('link');
    setMsg('');
    try {
      const res = await fetch('/api/link/create', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      setMsg('Link code ready. Open WhatsApp and send the message.');
      await load();
      setOpen('whatsapp');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy('');
    }
  }

  async function addTrusted(e: React.FormEvent) {
    e.preventDefault();
    setBusy('trusted');
    setMsg('');
    try {
      const res = await fetch('/api/trusted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: addr.trim(),
          label: label.trim(),
          password,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      setAddr('');
      setLabel('');
      setPassword('');
      setMsg(`Saved trusted wallet "${label.trim() || shortAddr(addr)}".`);
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy('');
    }
  }

  async function removeTrusted(address: string) {
    if (!removePassword) {
      setMsg('Enter your password below, then click Remove again.');
      setRemoving(address);
      return;
    }
    setBusy('remove');
    setMsg('');
    try {
      const res = await fetch('/api/trusted', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password: removePassword }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      setRemovePassword('');
      setRemoving(null);
      setMsg('Trusted wallet removed.');
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy('');
    }
  }

  async function setUnlockPin(e: React.FormEvent) {
    e.preventDefault();
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
      setPin('');
      setMsg('PIN saved. On WhatsApp: flizy unlock your-pin');
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy('');
    }
  }

  if (error && !data) {
    return (
      <div className="fade-up mx-auto max-w-md space-y-5">
        <h1 className="font-sans text-3xl tracking-wide text-paper">Dashboard</h1>
        <div className="alert alert-warn">{error}</div>
        <div className="flex gap-3">
          <Link href="/login" className="btn btn-primary">
            Log in
          </Link>
          <Link href="/signup" className="btn btn-ghost">
            Create account
          </Link>
        </div>
      </div>
    );
  }

  if (!data) {
    return <p className="text-sm text-muted">Loading your dashboard...</p>;
  }

  const explorerBase =
    holdings?.holdings?.chain?.explorerBaseUrl || 'https://sepolia-explorer.giwa.io';

  return (
    <div className="fade-up space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-gold">Your control room</p>
          <h1 className="mt-2 font-sans text-3xl tracking-wide text-paper">Dashboard</h1>
          <p className="mt-2 text-sm text-muted">
            {data.account.display_name || data.account.email}
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:max-w-md sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <label className="label" htmlFor="jump">
              Jump to section
            </label>
            <select
              id="jump"
              className="input"
              value={jump || open}
              onChange={(e) => onJumpChange(e.target.value)}
            >
              {SECTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn btn-ghost whitespace-nowrap"
            onClick={refreshAll}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {welcome ? (
        <div className="alert alert-ok">
          Welcome. Use the dropdown to open each section. Add a trusted wallet (with password), then
          link WhatsApp.
        </div>
      ) : null}
      {msg ? <div className="alert alert-ok">{msg}</div> : null}

      <div className="space-y-3">
        <AccordionSection
          id="overview"
          title="Overview"
          badge="Start here"
          open={open === 'overview'}
          onToggle={onToggle}
        >
          <ul className="space-y-3">
            {checklist.map((item) => (
              <li key={item.title} className="flex items-start gap-3 border-b border-border pb-3 last:border-0">
                <span className={item.done ? 'step-check' : 'text-muted'}>
                  {item.done ? '[x]' : '[ ]'}
                </span>
                <div>
                  <p className="text-sm text-paper">{item.title}</p>
                  <p className="text-xs text-muted">{item.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted">
            DEX swaps for all tokens come later. Today: send to trusted names with credit.
          </p>
        </AccordionSection>

        <AccordionSection
          id="wallet"
          title="Wallet and holdings"
          badge={`${data.account.balance_eth ?? 0} credit`}
          open={open === 'wallet'}
          onToggle={onToggle}
        >
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted">Credit, agent wallet, and on-chain balances.</p>
              <button
                type="button"
                className="btn btn-primary text-sm"
                onClick={refreshAll}
                disabled={refreshing}
              >
                {refreshing ? 'Refreshing...' : 'Refresh balances'}
              </button>
            </div>
            <div>
              <p className="label">How sending works</p>
              <p className="text-sm leading-relaxed text-muted">
                Sends use <span className="text-paper">this agent wallet</span> as From. Fund it with
                GIWA Sepolia ETH, add trusted names, then flizy send and confirm on WhatsApp.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <a
                  href="https://cloud.google.com/application/web3/faucet"
                  className="btn btn-ghost text-sm"
                  target="_blank"
                  rel="noreferrer"
                >
                  Google faucet
                </a>
                <a
                  href="https://bridge-giwa.vercel.app/"
                  className="btn btn-ghost text-sm"
                  target="_blank"
                  rel="noreferrer"
                >
                  GIWA bridge
                </a>
              </div>
            </div>
            <div>
              <p className="label">Agent wallet</p>
              <p className="mono-box text-sm">
                {data.account.agent_wallet_address || 'Generating...'}
              </p>
              {data.account.agent_wallet_address ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <CopyButton value={data.account.agent_wallet_address} label="Copy address" />
                  <a
                    className="btn btn-ghost text-sm"
                    href={`${explorerBase}/address/${data.account.agent_wallet_address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Explorer
                  </a>
                </div>
              ) : null}
            </div>
            <div>
              <p className="label">On-chain holdings</p>
              {holdings?.holdings?.native ? (
                <p className="text-sm text-paper">
                  {holdings.holdings.native.symbol}:{' '}
                  <span className="text-lime">
                    {Number(holdings.holdings.native.balance).toFixed(6)}
                  </span>
                </p>
              ) : (
                <p className="text-sm text-muted">No on-chain balance yet (or wallet pending).</p>
              )}
              {holdings?.holdings?.tokens?.length ? (
                <ul className="mt-2 space-y-1 text-sm">
                  {holdings.holdings.tokens.map((t) => (
                    <li key={t.address || t.symbol} className="text-muted">
                      {t.symbol}:{' '}
                      <span className="text-paper">
                        {t.balance == null ? t.error || 'n/a' : Number(t.balance).toPrecision(6)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted">
                  {holdings?.holdings?.note ||
                    'Token list expands with TRACKED_TOKENS. Full multi-token discovery ships with DEX.'}
                </p>
              )}
            </div>
            <p className="text-xs text-muted">
              WhatsApp: <span className="text-paper">flizy balance</span> shows the same holdings
              summary.
            </p>
          </div>
        </AccordionSection>

        <AccordionSection
          id="trusted"
          title="Trusted wallets"
          badge={`${data.trusted.length} saved`}
          open={open === 'trusted'}
          onToggle={onToggle}
        >
          <p className="mb-4 text-sm text-muted">
            Paste a wallet address, give it a short name, enter your account password, then save.
            Password is required every time you add or remove a trusted wallet.
          </p>
          <form onSubmit={addTrusted} className="grid gap-3">
            <div>
              <label className="label">Name (what you type on WhatsApp)</label>
              <input
                className="input"
                placeholder="nald, mum, junior"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Wallet address</label>
              <input
                className="input"
                placeholder="0x..."
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Your account password</label>
              <input
                className="input"
                type="password"
                placeholder="Confirm it is you"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy === 'trusted'}>
              {busy === 'trusted' ? 'Saving...' : 'Save trusted wallet'}
            </button>
          </form>

          <div className="mt-6 space-y-3">
            <p className="label">Saved</p>
            {data.trusted.length === 0 ? (
              <p className="text-sm text-muted">None yet.</p>
            ) : (
              data.trusted.map((t) => (
                <div
                  key={t.address}
                  className="flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-lime">{t.label || 'unnamed'}</p>
                    <p className="truncate text-xs text-muted">{t.address}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <CopyButton value={t.address} label="Copy" />
                    <button
                      type="button"
                      className="btn btn-ghost text-sm"
                      onClick={() => removeTrusted(t.address)}
                      disabled={busy === 'remove'}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))
            )}
            {data.trusted.length > 0 ? (
              <div className="pt-2">
                <label className="label">Password to remove a wallet</label>
                <input
                  className="input"
                  type="password"
                  placeholder={
                    removing
                      ? `Password to remove ${shortAddr(removing)}`
                      : 'Enter password, then click Remove'
                  }
                  value={removePassword}
                  onChange={(e) => setRemovePassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
            ) : null}
          </div>
        </AccordionSection>

        <AccordionSection
          id="whatsapp"
          title="WhatsApp link"
          open={open === 'whatsapp'}
          onToggle={onToggle}
        >
          <div className="mb-6 rounded border border-border bg-ink/80 p-4 text-sm">
            <p className="font-sans text-paper">Open the bot safely</p>
            <ul className="mt-3 space-y-2 text-xs text-muted sm:text-sm">
              <li>
                Generate a code below, then use <span className="text-paper">Open WhatsApp</span>. That
                opens the bot chat without publishing a phone number on the public site.
              </li>
              <li>
                Do not type Flizy commands inside other people&apos;s chats or groups.
              </li>
              <li>
                Full guide for any country:{' '}
                <a href="/how-it-works" className="text-lime no-underline hover:text-gold">
                  How to use Flizy
                </a>
              </li>
            </ul>
          </div>
          <p className="mb-4 text-sm text-muted">
            Generate a one-time code, open WhatsApp, send the message. The bot will show your wallet
            and email when linking works.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={generateLink}
            disabled={busy === 'link'}
          >
            {busy === 'link' ? 'Generating...' : 'Generate link code'}
          </button>
          {data.link ? (
            <div className="mt-4 space-y-3 rounded border border-border bg-ink p-4">
              <p className="font-sans text-2xl tracking-wide text-lime">{data.link.code}</p>
              <p className="text-xs text-muted">
                Expires {new Date(data.link.expiresAt).toLocaleString()}
              </p>
              <div className="mono-box text-sm">flizy link {data.link.code}</div>
              <div className="flex flex-wrap gap-2">
                <CopyButton value={`flizy link ${data.link.code}`} label="Copy message" />
                <a
                  href={data.link.waDeepLink}
                  className="btn btn-primary text-sm"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open WhatsApp
                </a>
              </div>
            </div>
          ) : null}
        </AccordionSection>

        <AccordionSection
          id="pin"
          title="Unlock PIN"
          badge={data.account.has_pin ? 'Set' : 'Optional'}
          open={open === 'pin'}
          onToggle={onToggle}
        >
          <p className="mb-4 text-sm text-muted">
            On WhatsApp: <span className="text-paper">flizy unlock 1234</span>. Never shown back in
            chat.
          </p>
          <form onSubmit={setUnlockPin} className="flex flex-col gap-3 sm:flex-row">
            <input
              className="input"
              type="password"
              inputMode="numeric"
              minLength={4}
              maxLength={12}
              placeholder="4-12 digits"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              required
            />
            <button className="btn btn-primary" type="submit" disabled={busy === 'pin'}>
              {busy === 'pin' ? 'Saving...' : 'Save PIN'}
            </button>
          </form>
        </AccordionSection>

        <AccordionSection
          id="history"
          title="Transfer history"
          badge="Last 10"
          open={open === 'history'}
          onToggle={onToggle}
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted">
              Same last 10 as <span className="text-paper">flizy history</span> on WhatsApp.
            </p>
            <button
              type="button"
              className="btn btn-ghost text-sm"
              onClick={refreshAll}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
          {history.length === 0 ? (
            <p className="text-sm text-muted">No transfers yet.</p>
          ) : (
            <ul className="space-y-3">
              {history.map((row) => (
                <li key={row.id} className="border-b border-border pb-3 text-sm last:border-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-lime">{row.amount_eth} ETH</span>
                    <span className="badge">{row.status}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">To {shortAddr(row.to_address)}</p>
                  <p className="text-xs text-muted">{new Date(row.created_at).toLocaleString()}</p>
                  {row.tx_hash ? (
                    <a
                      className="mt-1 inline-block text-xs text-lime no-underline hover:text-gold"
                      href={`${explorerBase}/tx/${row.tx_hash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View tx
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </AccordionSection>
      </div>
    </div>
  );
}
