'use client';

import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, PlusIcon } from './ExploreIcons';
import { formatAmount } from '../lib/amountDisplay';
import { SAVINGS_ASSET, SAVINGS_HELPER } from '../lib/reservesMath';

/** ETH kept out of Max when moving into Savings, so later sends can still pay gas. The server keeps its own. */
const GAS_KEEP_ETH = 0.0002;

export type SavingsRow = {
  asset: string;
  label: string;
  amount: string;
  amountBase: string;
  decimals: number;
};

type Status = 'loading' | 'error' | 'missing' | 'ready';
type Direction = 'to_savings' | 'to_spending';

/**
 * Savings, kept out of sight: money moved off Spending. The wallet shows only
 * Available and a small + beside it. Nothing about Savings, not even whether
 * it holds anything, is on the page until the + is tapped. The sheet it opens
 * shows what is in Savings and moves ETH in or transfers it back: amount,
 * review, confirm. Savings takes ETH only; a token put there before that rule
 * can still be transferred back.
 */
export function SavingsButton({
  status,
  rows,
  available,
  onMoved,
}: {
  status: Status;
  rows: SavingsRow[];
  /** Available ETH (chain balance minus Savings), or null while it is not known. */
  available: string | null;
  onMoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Savings"
        aria-haspopup="dialog"
        className="hit-44 flex h-[14px] w-[14px] items-center justify-center text-[#6f6f6f] hover:text-[#cfcfcf]"
      >
        <PlusIcon size={11} />
      </button>
      {open ? (
        <SavingsSheet
          status={status}
          rows={rows.filter((row) => row.amountBase !== '0')}
          available={available}
          onClose={() => setOpen(false)}
          onMoved={onMoved}
        />
      ) : null}
    </>
  );
}

function SavingsSheet({
  status,
  rows,
  available,
  onClose,
  onMoved,
}: {
  status: Status;
  rows: SavingsRow[];
  available: string | null;
  onClose: () => void;
  onMoved: () => void;
}) {
  const titleId = useId();
  const [direction, setDirection] = useState<Direction>('to_savings');
  const [asset, setAsset] = useState(SAVINGS_ASSET);
  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState<'edit' | 'review' | 'done'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [doneText, setDoneText] = useState('');

  const saving = direction === 'to_savings';
  // Into Savings is ETH only. Out of it is whatever is there.
  const row = rows.find((r) => r.asset === (saving ? SAVINGS_ASSET : asset)) || null;
  const label = saving ? 'ETH' : row?.label || asset;
  const fromLabel = saving ? 'Spending' : 'Savings';
  const toLabel = saving ? 'Savings' : 'Spending';
  const maxNum = saving ? Math.max(0, Number(available ?? 0) - GAS_KEEP_ETH) : Number(row?.amount ?? 0);
  const maxText = saving ? String(Number(maxNum.toFixed(6))) : row?.amount ?? '0';
  const amountNum = Number(amount);
  const tooMuch = amountNum > maxNum + 1e-12;
  const canReview = amountNum > 0 && !tooMuch && !(saving && available == null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [busy, onClose]);

  function pick(next: Direction) {
    if (busy) return;
    setDirection(next);
    setAsset(next === 'to_spending' && rows.length && !rows.some((r) => r.asset === SAVINGS_ASSET) ? rows[0].asset : SAVINGS_ASSET);
    setAmount('');
    setError('');
    setStage('edit');
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/reserves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset: saving ? SAVINGS_ASSET : asset, amount, direction }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof body.error === 'string' ? body.error : 'Could not move that. Nothing changed.');
        setStage('edit');
        return;
      }
      setDoneText(`${body.amount || amount} ${body.label || label} moved to ${toLabel}.`);
      setStage('done');
      onMoved();
    } catch {
      setError('Could not move that. Nothing changed.');
      setStage('edit');
    } finally {
      setBusy(false);
    }
  }

  const tab = (value: Direction, text: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={direction === value}
      onClick={() => pick(value)}
      disabled={busy}
      className={`h-[40px] rounded-[4px] font-sans text-[13px] font-semibold ${
        direction === value ? 'border border-[#3a3017] bg-[#1c180c] text-sun' : 'border border-transparent text-[#a9a9a9] hover:text-white'
      }`}
    >
      {text}
    </button>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[75] flex items-end justify-center bg-black/75 backdrop-blur-[3px] sm:items-center sm:p-4"
      role="presentation"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[94dvh] w-full max-w-[460px] flex-col overflow-hidden rounded-t-[24px] border border-b-0 border-[#2c2416] bg-[#0c0c0c] shadow-[0_-24px_70px_rgba(0,0,0,0.65)] sm:rounded-[24px] sm:border-b"
      >
        <div className="overflow-y-auto px-4 pb-5 pt-3 sm:px-5">
          <div className="mx-auto h-1 w-10 rounded-full bg-[#3a3a3a]" aria-hidden />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="absolute right-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-[#2e2e2e] bg-[#141414] text-[#e6e6e6]"
            aria-label="Close"
          >
            <CloseIcon size={16} />
          </button>

          <h2 id={titleId} className="m-0 mt-3 pr-12 font-sans text-[20px] font-bold text-[#f5f5f5]">
            Savings
          </h2>
          <p className="m-0 mt-1 pr-12 font-sans text-[12.5px] leading-[1.45] text-[#a9a9a9]">
            Savings holds ETH. Money in Savings cannot be sent, swapped or traded until you transfer it back to Spending.
          </p>

          {status === 'ready' ? (
            <>
              <div className="mt-4 rounded-[6px] border border-[#2a2b30] bg-[#0f0f10] p-3">
                <p className="m-0 font-mono text-[10px] uppercase tracking-[0.12em] text-[#a9a9a9]">In Savings</p>
                {rows.length === 0 ? (
                  <p className="m-0 mt-2 font-sans text-[13px] text-[#cfcfcf]">Nothing yet.</p>
                ) : (
                  <ul className="m-0 mt-2 grid list-none gap-[6px] p-0">
                    {rows.map((r) => (
                      <li key={r.asset} className="flex items-baseline justify-between gap-3">
                        <span className="font-mono text-[12px] uppercase tracking-[0.06em] text-[#cfcfcf]">{r.label}</span>
                        <span className="font-sans text-[16px] font-semibold text-white">{formatAmount(r.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div role="tablist" aria-label="Direction" className="mt-4 grid grid-cols-2 gap-[6px] rounded-[6px] border border-[#2a2b30] bg-[#0f0f10] p-[4px]">
                {tab('to_savings', 'Move to Savings')}
                {tab('to_spending', 'Transfer')}
              </div>
            </>
          ) : null}

          {status !== 'ready' ? (
            <p className="m-0 mt-5 font-sans text-[13px] text-[#cfcfcf]">
              {status === 'loading' ? 'Reading Savings...' : status === 'missing' ? 'Savings is not available yet.' : 'Could not read Savings.'}
            </p>
          ) : stage === 'done' ? (
            <div className="mt-5 grid gap-3">
              <p className="m-0 font-sans text-[15px] font-semibold text-white">Done</p>
              <p className="m-0 font-sans text-[13px] text-[#cfcfcf]">{doneText}</p>
              <button
                type="button"
                onClick={onClose}
                className="h-[44px] rounded-[4px] border border-[#333] bg-[#0f0f10] font-sans text-[13px] font-semibold text-[#ececec]"
              >
                Close
              </button>
            </div>
          ) : !saving && rows.length === 0 ? (
            <p className="m-0 mt-5 font-sans text-[13px] text-[#cfcfcf]">Nothing is in Savings to transfer.</p>
          ) : stage === 'review' ? (
            <div className="mt-5 grid gap-3">
              <dl className="m-0 grid gap-[8px] rounded-[6px] border border-[#2a2b30] bg-[#0f0f10] p-3 font-sans text-[13px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-[#a9a9a9]">Amount</dt>
                  <dd className="m-0 text-white">
                    {formatAmount(amount)} {label}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[#a9a9a9]">From</dt>
                  <dd className="m-0 text-white">{fromLabel}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[#a9a9a9]">To</dt>
                  <dd className="m-0 text-white">{toLabel}</dd>
                </div>
              </dl>
              <p className="m-0 font-sans text-[11.5px] leading-[1.45] text-[#8a8a8a]">
                Nothing leaves your wallet. This only changes what Flizy lets you spend.
              </p>
              <div className="grid grid-cols-2 gap-[8px]">
                <button
                  type="button"
                  onClick={() => setStage('edit')}
                  disabled={busy}
                  className="h-[44px] rounded-[4px] border border-[#333] bg-[#0f0f10] font-sans text-[13px] font-semibold text-[#ececec] disabled:opacity-40"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => void confirm()}
                  disabled={busy}
                  className="h-[44px] rounded-[4px] border border-[#3a3017] bg-[#14120a] font-sans text-[13px] font-semibold text-[#f5c842] disabled:opacity-40"
                >
                  {busy ? 'Moving...' : 'Confirm'}
                </button>
              </div>
            </div>
          ) : (
            <form
              className="mt-5 grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (canReview) setStage('review');
              }}
            >
              {!saving && rows.length > 1 ? (
                <select
                  value={asset}
                  onChange={(e) => {
                    setAsset(e.target.value);
                    setAmount('');
                  }}
                  aria-label="Asset to transfer"
                  className="h-[44px] rounded-[4px] border border-[#2a2b30] bg-[#0b0b0c] px-[10px] font-mono text-[13px] text-[#f5f5f5]"
                >
                  {rows.map((r) => (
                    <option key={r.asset} value={r.asset}>
                      {r.label}
                    </option>
                  ))}
                </select>
              ) : null}
              <div className="flex items-center justify-between font-sans text-[12px] text-[#a9a9a9]">
                <span>{saving ? 'Available to move' : 'In Savings'}</span>
                <span className="text-[#ececec]">
                  {saving && available == null ? '...' : `${formatAmount(maxText)} ${label}`}
                </span>
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-[8px]">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/,/g, ''))}
                  inputMode="decimal"
                  autoComplete="off"
                  aria-label={`Amount of ${label}`}
                  placeholder={`0.00 ${label}`}
                  className="h-[44px] rounded-[4px] border border-[#2a2b30] bg-[#0b0b0c] px-[12px] font-sans text-[15px] text-[#f5f5f5] outline-none focus:border-[#3a3017]"
                />
                <button
                  type="button"
                  onClick={() => setAmount(maxText)}
                  disabled={maxNum <= 0}
                  className="h-[44px] rounded-[4px] border border-[#333] bg-[#0f0f10] px-4 font-sans text-[12px] font-semibold text-[#ececec] disabled:opacity-40"
                >
                  Max
                </button>
              </div>
              {tooMuch ? (
                <p className="m-0 font-sans text-[11.5px] text-[#cfcfcf]">
                  {saving ? 'That is more than you have available.' : 'That is more than is in Savings.'}
                </p>
              ) : null}
              {error ? <p className="m-0 whitespace-pre-line font-sans text-[11.5px] text-[#cfcfcf]">{error}</p> : null}
              <button
                type="submit"
                disabled={!canReview}
                className="h-[44px] rounded-[4px] border border-[#3a3017] bg-[#14120a] font-sans text-[13px] font-semibold text-[#f5c842] disabled:opacity-40"
              >
                Review
              </button>
            </form>
          )}
          <p className="m-0 mt-4 font-sans text-[11px] leading-[1.45] text-[#8a8a8a]">{SAVINGS_HELPER}</p>
        </div>
      </div>
    </div>,
    document.body
  );
}
