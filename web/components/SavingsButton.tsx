'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon, CloseIcon, LockIcon, PlusIcon } from './ExploreIcons';
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

/** What the done step shows, from the move's own response. */
type Done = { saving: boolean; amount: string; label: string; saved: string | null };

/**
 * Savings, kept out of sight: money moved off Spending. The wallet shows only
 * Available and a small + beside it. Nothing about Savings, not even whether
 * it holds anything, is on the page until the + is tapped. The sheet it opens
 * shows what is in Savings and moves ETH in or transfers it back to Spending:
 * amount, review, confirm, done. Savings takes ETH only; a token put there
 * before that rule can still be transferred back.
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

/** Three stacked sheets: the Savings mark. */
function LayersGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <path d="M12 3 3 7.5 12 12l9-4.5L12 3Z" />
      <path d="m3 12 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </svg>
  );
}

/** Label and value rows inside one bordered card, split by hairlines. */
function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="m-0 rounded-[12px] border border-[#2a2b30] bg-[#0f0f10] px-4 font-sans text-[14px]">
      {rows.map(([name, value], i) => (
        <div key={name} className={`flex items-center justify-between gap-3 py-3 ${i ? 'border-t border-[#24252a]' : ''}`}>
          <dt className="text-[#a9a9a9]">{name}</dt>
          <dd className="m-0 font-semibold text-white">{value}</dd>
        </div>
      ))}
    </dl>
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
  const [done, setDone] = useState<Done | null>(null);

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
  const ethSaved = rows.find((r) => r.asset === SAVINGS_ASSET)?.amount ?? '0';
  const otherSaved = rows.filter((r) => r.asset !== SAVINGS_ASSET);

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
      setDone({
        saving,
        amount: typeof body.amount === 'string' ? body.amount : formatAmount(amount),
        label: typeof body.label === 'string' ? body.label : label,
        saved: typeof body.saved === 'string' ? body.saved : null,
      });
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
      className={`h-[46px] rounded-[11px] font-sans text-[13.5px] font-semibold ${
        direction === value
          ? 'border border-sun bg-[linear-gradient(180deg,#3a2e12_0%,#221b0b_100%)] text-white'
          : 'border border-transparent text-[#d9d9d9] hover:text-white'
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
        className="relative flex max-h-[94dvh] w-full max-w-[460px] flex-col overflow-hidden rounded-t-[24px] border border-b-0 border-[#2c2c30] bg-[#0c0c0c] shadow-[0_-24px_70px_rgba(0,0,0,0.65)] sm:rounded-[24px] sm:border-b"
      >
        <div className="overflow-y-auto px-4 pb-5 pt-3 sm:px-5">
          <div className="mx-auto h-1 w-10 rounded-full bg-[#3a3a3a]" aria-hidden />

          <div className="mt-4 flex items-center gap-3">
            <span className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[12px] border border-[#3a3017] bg-[#1c180c] text-sun" aria-hidden>
              <LayersGlyph />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="m-0 font-sans text-[22px] font-bold leading-tight text-[#f5f5f5]">
                Savings
              </h2>
              <p className="m-0 mt-0.5 font-sans text-[12px] text-[#a9a9a9]">Keep funds separate from spending.</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="hit-44 flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[#2e2e2e] bg-[#121212] text-[#e6e6e6]"
              aria-label="Close"
            >
              <CloseIcon size={16} />
            </button>
          </div>

          {status !== 'ready' ? (
            <p className="m-0 mt-5 font-sans text-[13px] text-[#cfcfcf]">
              {status === 'loading' ? 'Reading Savings...' : status === 'missing' ? 'Savings is not available yet.' : 'Could not read Savings.'}
            </p>
          ) : stage === 'done' && done ? (
            <div className="mt-5 grid gap-4">
              <div className="flex items-center gap-3">
                <span className="flex h-[34px] w-[34px] items-center justify-center rounded-full border-[1.5px] border-sun text-sun" aria-hidden>
                  <CheckIcon size={16} />
                </span>
                <p className="m-0 font-sans text-[18px] font-semibold text-white">{done.saving ? 'Move complete' : 'Transfer complete'}</p>
              </div>
              <div>
                <p className="m-0 font-sans text-[30px] font-bold leading-none text-white">
                  {done.amount} {done.label}
                </p>
                <p className="m-0 mt-1.5 font-sans text-[14px] text-[#a9a9a9]">Moved to {done.saving ? 'Savings' : 'Spending'}</p>
              </div>
              <Facts
                rows={[
                  ['From', done.saving ? 'Spending' : 'Savings'],
                  ['To', done.saving ? 'Savings' : 'Spending'],
                ]}
              />
              <p className="m-0 font-sans text-[13px] leading-[1.45] text-[#a9a9a9]">
                {done.saving
                  ? 'These funds are set aside and cannot be sent, swapped or traded.'
                  : 'Your funds are now available for sending and swapping.'}
              </p>
              {done.saved != null ? (
                <div className="flex items-center justify-between gap-3 rounded-[12px] border border-[#5a4a1f] bg-[#16130b] px-4 py-3.5 font-sans text-[14px]">
                  <span className="text-[#e6e6e6]">{done.saving ? 'Now in Savings' : 'Remaining in Savings'}</span>
                  <span className="font-semibold text-white">
                    {done.saved} {done.label}
                  </span>
                </div>
              ) : null}
              <button type="button" onClick={onClose} className="btn-sun h-[52px] w-full rounded-[12px] font-sans text-[15px] font-semibold">
                Done
              </button>
              <p className="m-0 text-center font-sans text-[11.5px] text-[#8a8a8a]">
                Savings funds remain unavailable for spending until transferred back.
              </p>
            </div>
          ) : (
            <>
              <div className="mt-5 flex items-center gap-4 rounded-[14px] border border-[#2a2b30] bg-[#0f0f10] px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="m-0 font-mono text-[11px] uppercase tracking-[0.14em] text-[#a9a9a9]">In Savings</p>
                  <p className="m-0 mt-1 truncate font-sans text-[26px] font-bold leading-tight text-white">{formatAmount(ethSaved)} ETH</p>
                  {otherSaved.map((r) => (
                    <p key={r.asset} className="m-0 mt-0.5 font-sans text-[12px] text-[#cfcfcf]">
                      {formatAmount(r.amount)} {r.label}
                    </p>
                  ))}
                </div>
                <span className="h-[44px] w-px shrink-0 bg-[#2a2b30]" aria-hidden />
                <span className="inline-flex h-[32px] shrink-0 items-center gap-1.5 rounded-[9px] border border-[#3a3017] bg-[#2a2210] px-3 font-sans text-[12.5px] font-medium text-sun">
                  <LockIcon size={14} />
                  Locked
                </span>
              </div>

              <div role="tablist" aria-label="Direction" className="mt-4 grid grid-cols-2 rounded-[12px] border border-[#2a2b30] p-[2px]">
                {tab('to_savings', 'Move to Savings')}
                {tab('to_spending', 'Transfer to Spending')}
              </div>

              {!saving && rows.length === 0 ? (
                <p className="m-0 mt-5 font-sans text-[13px] text-[#cfcfcf]">Nothing is in Savings to transfer.</p>
              ) : stage === 'review' ? (
                <div className="mt-5 grid gap-3.5">
                  <Facts
                    rows={[
                      ['Amount', `${formatAmount(amount)} ${label}`],
                      ['From', fromLabel],
                      ['To', toLabel],
                    ]}
                  />
                  <p className="m-0 font-sans text-[13px] leading-[1.45] text-[#a9a9a9]">
                    Nothing leaves your wallet. This only changes what Flizy lets you spend.
                  </p>
                  <div className="grid grid-cols-2 gap-[10px]">
                    <button
                      type="button"
                      onClick={() => setStage('edit')}
                      disabled={busy}
                      className="h-[50px] rounded-[12px] border border-[#3a3a3e] bg-transparent font-sans text-[14px] font-semibold text-white disabled:opacity-40"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={() => void confirm()}
                      disabled={busy}
                      className="btn-sun h-[50px] rounded-[12px] font-sans text-[14px] font-semibold"
                    >
                      {busy ? 'Moving...' : 'Confirm'}
                    </button>
                  </div>
                  <p className="m-0 border-t border-[#24252a] pt-3.5 font-sans text-[11.5px] leading-[1.45] text-[#8a8a8a]">{SAVINGS_HELPER}</p>
                </div>
              ) : (
                <form
                  className="mt-5 grid gap-3.5"
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
                      className="h-[48px] rounded-[12px] border border-[#2a2b30] bg-[#0b0b0c] px-3 font-mono text-[13px] text-[#f5f5f5]"
                    >
                      {rows.map((r) => (
                        <option key={r.asset} value={r.asset}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <div className="flex items-center justify-between gap-3 font-sans text-[14px]">
                    <span className="text-[#a9a9a9]">{saving ? 'Available to move' : 'Available to transfer'}</span>
                    <span className="text-white">{saving && available == null ? '...' : `${formatAmount(maxText)} ${label}`}</span>
                  </div>
                  <div className="flex h-[52px] items-center rounded-[12px] border border-[#2a2b30] bg-[#0b0b0c] focus-within:border-[#5a4a1f]">
                    <input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/,/g, ''))}
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label={`Amount of ${label}`}
                      placeholder={`Amount (${label})`}
                      className="h-full min-w-0 flex-1 bg-transparent px-4 font-sans text-[16px] text-[#f5f5f5] outline-none placeholder:text-[#77777c]"
                    />
                    <span className="h-[26px] w-px bg-[#2a2b30]" aria-hidden />
                    <button
                      type="button"
                      onClick={() => setAmount(maxText)}
                      disabled={maxNum <= 0}
                      className="h-full px-5 font-sans text-[15px] font-semibold text-sun disabled:opacity-40"
                    >
                      Max
                    </button>
                  </div>
                  {tooMuch ? (
                    <p className="m-0 font-sans text-[12px] text-[#cfcfcf]">
                      {saving ? 'That is more than you have available.' : 'That is more than is in Savings.'}
                    </p>
                  ) : null}
                  {error ? <p className="m-0 whitespace-pre-line font-sans text-[12px] text-[#cfcfcf]">{error}</p> : null}
                  <button type="submit" disabled={!canReview} className="btn-sun h-[52px] w-full rounded-[12px] font-sans text-[15px] font-semibold">
                    Review
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
