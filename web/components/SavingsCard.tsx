'use client';

import { useState } from 'react';
import { AppCard as Card, AppCardHeader as CardHeader } from './AppCard';
import { formatAmount } from '../lib/amountDisplay';
import { LISTED_TOKENS, symbolLabel } from '../lib/listedTokens';
import { SAVINGS_HELPER } from '../lib/reservesMath';

const HIDDEN = '\u2022\u2022\u2022\u2022';

export type SavingsRow = {
  asset: string;
  label: string;
  amount: string;
  amountBase: string;
  decimals: number;
};

type Status = 'loading' | 'error' | 'missing' | 'ready';

function choices(rows: SavingsRow[]) {
  const map = new Map<string, string>();
  map.set('ETH', 'ETH');
  map.set('FLZ', 'FLZ');
  for (const token of LISTED_TOKENS) map.set(token.symbol, symbolLabel(token.symbol));
  for (const row of rows) map.set(row.asset, row.label || row.asset);
  return [...map.entries()].map(([asset, label]) => ({ asset, label }));
}

/**
 * Money moved off Spending. The hero above this card is Available.
 * Amounts follow the same eye as the rest of the wallet.
 */
export function SavingsCard({
  hidden,
  status,
  rows,
  onMoved,
}: {
  hidden: boolean;
  status: Status;
  rows: SavingsRow[];
  onMoved: () => void;
}) {
  const [asset, setAsset] = useState('ETH');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const options = choices(rows);
  const selected = options.some((item) => item.asset === asset) ? asset : 'ETH';

  async function move(direction: 'to_savings' | 'to_spending') {
    if (busy) return;
    setBusy(true);
    setNote('');
    setError('');
    try {
      const res = await fetch('/api/reserves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset: selected, amount, direction }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || 'Could not move that. Nothing changed.');
        return;
      }
      const where = direction === 'to_savings' ? 'Savings' : 'Spending';
      setNote(`${body.amount || amount} ${body.label || selected} moved to ${where}.`);
      setAmount('');
      onMoved();
    } catch {
      setError('Could not move that. Nothing changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="px-[13.5px] pb-[12px] pt-[12px]">
      <CardHeader
        icon={<span className="font-mono text-[11px] tracking-[0.04em]">S</span>}
        title="Savings"
        subtitle="Set aside from spending. It stays there until you move it back."
      />
      {status === 'loading' ? (
        <p className="m-0 mt-[10px] font-sans text-[11px] text-[#a9a9a9]">...</p>
      ) : null}
      {status === 'error' ? (
        <p className="m-0 mt-[10px] font-sans text-[11px] text-[#a9a9a9]">Could not read Savings.</p>
      ) : null}
      {status === 'missing' ? (
        <p className="m-0 mt-[10px] font-sans text-[11px] text-[#a9a9a9]">Savings is not available yet.</p>
      ) : null}
      {status === 'ready' ? (
        <>
          <ul className="m-0 mt-[12px] grid list-none gap-[6px] p-0">
            {rows.length === 0 ? (
              <li className="font-sans text-[12px] text-[#cfcfcf]">Nothing is in Savings.</li>
            ) : (
              rows.map((row) => (
                <li key={row.asset} className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-[#cfcfcf]">{row.label}</span>
                  <span className="font-sans text-[13px] text-[#f5f5f5]">{hidden ? HIDDEN : formatAmount(row.amount)}</span>
                </li>
              ))
            )}
          </ul>
          <form
            className="mt-[14px] grid gap-[8px]"
            onSubmit={(e) => {
              e.preventDefault();
            }}
          >
            <div className="grid grid-cols-[1fr_88px] gap-[8px]">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                aria-label="Amount to move"
                placeholder="Amount"
                className="h-[36px] rounded-[4px] border border-[#2a2b30] bg-[#0b0b0c] px-[10px] font-sans text-[13px] text-[#f5f5f5] outline-none"
              />
              <select
                value={selected}
                onChange={(e) => setAsset(e.target.value)}
                aria-label="Asset to move"
                className="h-[36px] rounded-[4px] border border-[#2a2b30] bg-[#0b0b0c] px-[8px] font-mono text-[12px] text-[#f5f5f5]"
              >
                {options.map((item) => (
                  <option key={item.asset} value={item.asset}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-[8px]">
              <button
                type="button"
                disabled={busy || !amount.trim()}
                onClick={() => void move('to_savings')}
                className="h-[36px] rounded-[4px] border border-[#333] bg-[#14120a] font-sans text-[12px] font-semibold text-[#f5c842] disabled:opacity-40"
              >
                To Savings
              </button>
              <button
                type="button"
                disabled={busy || !amount.trim()}
                onClick={() => void move('to_spending')}
                className="h-[36px] rounded-[4px] border border-[#333] bg-[#0f0f10] font-sans text-[12px] font-semibold text-[#ececec] disabled:opacity-40"
              >
                To Spending
              </button>
            </div>
          </form>
          {error ? <p className="m-0 mt-[8px] whitespace-pre-line font-sans text-[11px] text-[#cfcfcf]">{error}</p> : null}
          {note ? <p className="m-0 mt-[8px] font-sans text-[11px] text-[#cfcfcf]">{note}</p> : null}
          <p className="m-0 mt-[12px] font-sans text-[11px] leading-[1.45] text-[#8a8a8a]">{SAVINGS_HELPER}</p>
        </>
      ) : null}
    </Card>
  );
}
