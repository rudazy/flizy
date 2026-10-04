'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PasswordField } from './PasswordField';
import { useDashboard } from './DashboardProvider';
import { CloseIcon, EthDiamondIcon } from './ExploreIcons';
import { ethFromWei } from '../lib/nftFormat';

export function SheetRow({ label, value, strong = false }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 font-sans text-[12px]">
      <span className="text-[#a9a9a9]">{label}</span>
      <span className={strong ? 'font-semibold text-white' : 'text-[#e6e6e6]'}>{value}</span>
    </div>
  );
}

export function EthAmount({ wei }: { wei: bigint | string | null }) {
  const text = ethFromWei(wei == null ? null : wei.toString());
  return (
    <span className="inline-flex items-center gap-[4px]">
      <EthDiamondIcon size={11} className="text-[#cfcfcf]" />
      {text ?? '-'} ETH
    </span>
  );
}

export type SheetResult = { explorerUrl?: string; label?: string };

/**
 * Bottom sheet for every Flizy Mint action that sends a transaction: a mint,
 * creating a collection, setting up or changing a drop, publishing an
 * allowlist, pausing. The caller passes the summary (what it costs and where
 * the money goes); the sheet takes the account password and posts.
 */
export function MintActionSheet({
  title,
  subtitle,
  children,
  confirmLabel,
  url,
  body,
  onClose,
  onDone,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  confirmLabel: string;
  url: string;
  /** Request body without the password; the sheet adds it. */
  body: Record<string, unknown>;
  onClose: () => void;
  onDone: (result: SheetResult & Record<string, unknown>) => void;
}) {
  const { refreshAll } = useDashboard();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<SheetResult | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function submit() {
    if (busy || !password) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'That did not go through.');
        return;
      }
      setPassword('');
      setDone({ explorerUrl: data.explorerUrl, label: data.label });
      onDone(data);
      refreshAll().catch(() => undefined);
    } catch {
      setError('That did not go through.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 backdrop-blur-[2px]" role="presentation" onClick={() => !busy && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-[14px] border border-b-0 border-[#26272c] bg-[#101012] px-[18px] pb-[max(18px,env(safe-area-inset-bottom))] pt-[14px] outline-none"
      >
        <div className="mx-auto mb-[12px] h-[4px] w-[38px] rounded-full bg-[#2c2d33]" aria-hidden />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="m-0 font-sans text-[16px] font-bold text-white">{title}</h2>
            <p className="m-0 mt-[2px] truncate font-sans text-[12px] text-[#a9a9a9]">{subtitle}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="hit-44 flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[#1a1a1d] text-[#d9d9d9]">
            <CloseIcon size={14} />
          </button>
        </div>

        {done ? (
          <div className="mt-[16px] grid gap-[12px]">
            <p className="m-0 font-sans text-[13px] text-white">{done.label ? `${done.label}. Done.` : 'Done.'}</p>
            {done.explorerUrl ? (
              <a href={done.explorerUrl} target="_blank" rel="noreferrer noopener" className="font-sans text-[12px] text-sun no-underline">
                View the transaction
              </a>
            ) : null}
            <button type="button" onClick={onClose} className="btn-sun h-[42px] rounded-[6px] font-sans text-[13px]">
              Close
            </button>
          </div>
        ) : (
          <div className="mt-[16px] grid gap-[14px]">
            {children}
            <PasswordField label="Account password" value={password} onChange={setPassword} autoComplete="current-password" />
            {error ? <p className="alert alert-error m-0">{error}</p> : null}
            <button
              type="button"
              onClick={submit}
              disabled={busy || !password}
              className="btn-sun h-[44px] rounded-[6px] font-sans text-[13.5px] disabled:opacity-50"
            >
              {busy ? 'Confirming...' : confirmLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
