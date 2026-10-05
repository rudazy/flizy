'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { splitWalletPaste, walletLabel } from '../lib/copyPaste';

type Kind = 'trade' | 'mint';

type WalletRow = {
  address: string;
  label: string;
  enabled: boolean;
};

type Draft = {
  wallets: WalletRow[];
  allocationEth: string;
  perTradeEth: string;
  maxTradeEth: string;
  maxDailyEth: string;
  maxDailyCount: string;
  copyBuys: boolean;
  copySells: boolean;
  slippagePct: string;
};

type SetupResponse = {
  wallets?: WalletRow[];
  allocationEth?: string;
  perTradeEth?: string;
  maxTradeEth?: string;
  maxDailyEth?: string;
  maxDailyCount?: number;
  copyBuys?: boolean;
  copySells?: boolean;
  slippagePct?: string;
};

function fromSetup(kind: Kind, setup: SetupResponse): Draft {
  return {
    wallets: (setup.wallets || []).map((wallet, index) => ({
      address: wallet.address,
      label: wallet.label || walletLabel(index),
      enabled: wallet.enabled !== false,
    })),
    allocationEth: setup.allocationEth || '',
    perTradeEth: setup.perTradeEth || '',
    maxTradeEth: setup.maxTradeEth || '',
    maxDailyEth: setup.maxDailyEth || '',
    maxDailyCount: setup.maxDailyCount ? String(setup.maxDailyCount) : '',
    copyBuys: setup.copyBuys !== false,
    copySells: kind === 'mint' ? false : setup.copySells !== false,
    slippagePct: setup.slippagePct || '1',
  };
}

function toBody(kind: Kind, draft: Draft) {
  const count = draft.maxDailyCount.trim() === '' ? 0 : Number(draft.maxDailyCount);
  const perMint = draft.maxTradeEth;
  return {
    kind,
    wallets: draft.wallets.map((wallet) => ({ address: wallet.address, enabled: wallet.enabled })),
    allocationEth: draft.allocationEth,
    perTradeEth: kind === 'mint' ? perMint : draft.perTradeEth,
    maxTradeEth: kind === 'mint' ? perMint : draft.maxTradeEth,
    maxDailyEth: draft.maxDailyEth,
    maxDailyCount: kind === 'trade' ? 0 : count,
    copyBuys: draft.copyBuys,
    copySells: kind === 'mint' ? false : draft.copySells,
    slippagePct: kind === 'mint' ? '1' : draft.slippagePct,
  };
}

function short(address: string) {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function LimitField({
  label,
  value,
  inputMode,
  onChange,
}: {
  label: string;
  value: string;
  inputMode: 'decimal' | 'numeric';
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border py-3">
      <span className="min-w-[8.5rem] flex-1 text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-paper">
        {label}
      </span>
      <span className="ml-auto w-28 shrink-0">
        <input
          className="input font-mono text-sm"
          inputMode={inputMode}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
    </label>
  );
}

function Disclosure({
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  title: string;
  meta?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="card px-4">
      <button
        type="button"
        className="flex min-h-11 w-full items-center justify-between gap-3 text-left"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="flex items-baseline gap-2">
          <span className="font-sans text-sm tracking-wide text-paper">{title}</span>
          {meta ? <span className="font-mono text-[11px] text-muted">{meta}</span> : null}
        </span>
        <span className="font-mono text-[11px] text-muted">{open ? 'Close' : 'Open'}</span>
      </button>
      {open ? <div className="border-t border-border py-3">{children}</div> : null}
    </section>
  );
}

/**
 * Wallet list and limits for copy mint.
 *
 * Copy trade has its own panel. Each block here stays closed until it is
 * opened. Enter turns a paste into rows immediately. The save is the
 * account's configuration. This panel does not submit a transaction.
 */
export function CopySetupPanel({ kind }: { kind: Kind }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [paste, setPaste] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [walletsOpen, setWalletsOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch(`/api/copy?kind=${kind}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || 'Could not load this setup.');
        setDraft(fromSetup(kind, {}));
        return;
      }
      setDraft(fromSetup(kind, body.setup || {}));
    } catch {
      setError('Could not load this setup.');
      setDraft(fromSetup(kind, {}));
    }
  }, [kind]);

  useEffect(() => {
    load();
  }, [load]);

  async function persist(next: Draft): Promise<boolean> {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/copy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toBody(kind, next)),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || 'Could not save.');
        return false;
      }
      setDraft(fromSetup(kind, body.setup || {}));
      setNote('Saved.');
      return true;
    } catch {
      setError('Could not save.');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function addFromPaste() {
    if (!draft || saving) return;
    const split = splitWalletPaste(paste, draft.wallets.map((wallet) => wallet.address));
    if (split.error) {
      setError(split.error);
      setNote('');
      return;
    }
    const start = draft.wallets.length;
    const next: Draft = {
      ...draft,
      wallets: [
        ...draft.wallets,
        ...split.addresses.map((address, index) => ({
          address,
          label: walletLabel(start + index),
          enabled: true,
        })),
      ],
    };
    setPaste('');
    setDraft(next);
    const skipped =
      split.skipped > 0
        ? `${split.skipped} ${split.skipped === 1 ? 'line was' : 'lines were'} not a wallet address.`
        : '';
    const ok = await persist(next);
    if (!ok) setDraft(draft);
    else if (skipped) setNote(`${skipped} The rest are saved.`);
  }

  async function updateWallets(wallets: WalletRow[]) {
    if (!draft || saving) return;
    const next = { ...draft, wallets };
    setDraft(next);
    const ok = await persist(next);
    if (!ok) setDraft(draft);
  }

  const mint = kind === 'mint';

  return (
    <div className="grid w-full max-w-lg gap-3">
      <Disclosure title="Status" open={statusOpen} onToggle={() => setStatusOpen((open) => !open)}>
        <p className="m-0 text-sm leading-relaxed text-paper">
          {mint
            ? 'Mint copying is off. This screen spends nothing.'
            : 'Copying is off. This screen spends nothing.'}
        </p>
        <p className="mb-0 mt-1 text-xs leading-relaxed text-muted">
          {mint
            ? 'Saved on your account. Only collections listed on this page can be followed.'
            : 'Saved on your account.'}
        </p>
      </Disclosure>

      {error ? <p className="alert alert-error">{error}</p> : null}
      {note ? <p className="m-0 text-sm text-lime">{note}</p> : null}

      <Disclosure
        title="Wallets"
        meta={draft ? String(draft.wallets.length) : undefined}
        open={walletsOpen}
        onToggle={() => setWalletsOpen((open) => !open)}
      >
        <p className="m-0 text-xs text-muted">Paste addresses. Press Enter.</p>
        <textarea
          value={paste}
          onChange={(event) => setPaste(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              addFromPaste();
            }
          }}
          rows={3}
          spellCheck={false}
          placeholder={'0x...\n0x...'}
          aria-label="Wallet addresses"
          className="input mt-3 resize-y font-mono text-sm"
        />
        <button
          type="button"
          className="btn btn-ghost mt-3 w-full"
          disabled={saving || !draft}
          onClick={addFromPaste}
        >
          Add wallets
        </button>

        <div className="mt-4 border-t border-border pt-3">
          {!draft ? <p className="m-0 text-sm text-muted">Loading...</p> : null}
          {draft && draft.wallets.length === 0 ? (
            <p className="m-0 text-sm text-muted">No wallets yet.</p>
          ) : null}
          {draft && draft.wallets.length > 0 ? (
            <ul className="m-0 max-h-80 list-none divide-y divide-border overflow-y-auto p-0">
              {draft.wallets.map((wallet) => (
                <li key={wallet.address} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="m-0 font-sans text-sm tracking-wide text-paper">{wallet.label}</p>
                    <p className="m-0 truncate font-mono text-[11px] text-muted">{short(wallet.address)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-pressed={wallet.enabled}
                      aria-label={`${wallet.label} ${wallet.enabled ? 'on' : 'off'}`}
                      disabled={saving}
                      onClick={() =>
                        updateWallets(
                          draft.wallets.map((row) =>
                            row.address === wallet.address ? { ...row, enabled: !row.enabled } : row
                          )
                        )
                      }
                      className={`min-h-11 min-w-11 rounded border px-2 font-mono text-xs ${
                        wallet.enabled ? 'border-lime/40 text-lime' : 'border-border text-muted'
                      }`}
                    >
                      {wallet.enabled ? 'ON' : 'OFF'}
                    </button>
                    <button
                      type="button"
                      className="min-h-11 px-2 text-xs text-muted"
                      disabled={saving}
                      aria-label={`Remove ${wallet.label}`}
                      onClick={() =>
                        updateWallets(draft.wallets.filter((row) => row.address !== wallet.address))
                      }
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Disclosure>

      <Disclosure title="Limits" open={limitsOpen} onToggle={() => setLimitsOpen((open) => !open)}>
        {!draft ? <p className="m-0 text-sm text-muted">Loading...</p> : null}
        {draft ? (
          <>
          <p className="m-0 text-xs leading-relaxed text-muted">
            Only this much of your spendable ETH can be used. The rest stays outside it.
          </p>
          <div className="mt-2">
            <LimitField
              label="Allocation (ETH)"
              inputMode="decimal"
              value={draft.allocationEth}
              onChange={(value) => setDraft({ ...draft, allocationEth: value })}
            />
            {mint ? (
              <LimitField
                label="Maximum per mint (ETH)"
                inputMode="decimal"
                value={draft.maxTradeEth}
                onChange={(value) => setDraft({ ...draft, maxTradeEth: value })}
              />
            ) : (
              <>
                <LimitField
                  label="Amount per trade (ETH)"
                  inputMode="decimal"
                  value={draft.perTradeEth}
                  onChange={(value) => setDraft({ ...draft, perTradeEth: value })}
                />
                <LimitField
                  label="Maximum per trade (ETH)"
                  inputMode="decimal"
                  value={draft.maxTradeEth}
                  onChange={(value) => setDraft({ ...draft, maxTradeEth: value })}
                />
              </>
            )}
            <LimitField
              label="Maximum daily spend (ETH)"
              inputMode="decimal"
              value={draft.maxDailyEth}
              onChange={(value) => setDraft({ ...draft, maxDailyEth: value })}
            />
            {mint ? (
              <LimitField
                label="Maximum mints per day"
                inputMode="numeric"
                value={draft.maxDailyCount}
                onChange={(value) => setDraft({ ...draft, maxDailyCount: value })}
              />
            ) : (
              <LimitField
                label="Slippage (%)"
                inputMode="decimal"
                value={draft.slippagePct}
                onChange={(value) => setDraft({ ...draft, slippagePct: value })}
              />
            )}
            <div className="flex items-center justify-between gap-3 border-b border-border py-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-paper">
                {mint ? 'Copy mints' : 'Copy buys'}
              </span>
              <button
                type="button"
                aria-pressed={draft.copyBuys}
                disabled={saving}
                onClick={() => setDraft({ ...draft, copyBuys: !draft.copyBuys })}
                className={`min-h-11 min-w-11 rounded border px-3 font-mono text-xs ${
                  draft.copyBuys ? 'border-lime/40 text-lime' : 'border-border text-muted'
                }`}
              >
                {draft.copyBuys ? 'ON' : 'OFF'}
              </button>
            </div>
            {mint ? null : (
              <div className="flex items-center justify-between gap-3 border-b border-border py-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-paper">Copy sells</span>
                <button
                  type="button"
                  aria-pressed={draft.copySells}
                  disabled={saving}
                  onClick={() => setDraft({ ...draft, copySells: !draft.copySells })}
                  className={`min-h-11 min-w-11 rounded border px-3 font-mono text-xs ${
                    draft.copySells ? 'border-lime/40 text-lime' : 'border-border text-muted'
                  }`}
                >
                  {draft.copySells ? 'ON' : 'OFF'}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary mt-4 w-full"
            disabled={saving}
            onClick={() => persist(draft)}
          >
            {saving ? 'Saving...' : 'Save limits'}
          </button>
          </>
        ) : null}
      </Disclosure>
    </div>
  );
}
