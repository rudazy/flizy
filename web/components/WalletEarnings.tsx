'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppCard, AppCardHeader } from './AppCard';
import { TagIcon } from './ExploreIcons';
import { ethFromWei } from '../lib/nftFormat';

type Source = 'market' | 'drop';
type Earnings = { market: string | null; drop: string | null };

const LABEL: Record<Source, string> = { market: 'NFT sales', drop: 'Mint sales' };

/**
 * ETH from NFT sales and mint sales that waits on chain for this wallet
 * (/api/earnings). Shown only when there is some, and always withdrawable,
 * whether or not the NFT features are paused, because it is the person's own
 * money. Withdrawing asks for the PIN only when the server says so.
 */
export function WalletEarnings({ hidden }: { hidden: boolean }) {
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [busy, setBusy] = useState<Source | null>(null);
  const [needPin, setNeedPin] = useState<Source | null>(null);
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/earnings');
      if (!res.ok) return;
      setEarnings((await res.json()) as Earnings);
    } catch {
      // Nothing to show is the safe answer: the card only appears with a balance.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function withdraw(source: Source) {
    setBusy(source);
    setMsg(null);
    try {
      const url = source === 'market' ? '/api/market/withdraw' : '/api/earnings';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(needPin === source ? { pin } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        if (body.code === 'PIN_REQUIRED' || body.code === 'PIN_WRONG') setNeedPin(source);
        setMsg({ ok: false, text: typeof body.error === 'string' ? body.error : 'Could not withdraw.' });
        return;
      }
      setNeedPin(null);
      setMsg({ ok: true, text: 'Withdrawn to your Flizy wallet.' });
      await load();
    } catch {
      setMsg({ ok: false, text: 'Could not withdraw. Check History before trying again.' });
    } finally {
      setBusy(null);
      setPin('');
    }
  }

  const rows = (['market', 'drop'] as const).filter((s) => {
    try {
      return BigInt(earnings?.[s] ?? '0') > 0n;
    } catch {
      return false;
    }
  });
  if (!rows.length && !msg) return null;

  return (
    <AppCard className="px-[12px] pb-[12px] pt-[12.5px]">
      <AppCardHeader icon={<TagIcon size={15} />} title="Earnings to withdraw" subtitle="ETH from your sales, held on chain until you withdraw it." />
      <ul className="m-0 mt-[11px] grid list-none gap-[6px] p-0">
        {rows.map((source) => (
          <li key={source} className="grid gap-[6px] rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] px-[10px] py-[9px]">
            <div className="flex items-center justify-between gap-3 font-sans text-[11px]">
              <span className="text-[#cfcfcf]">{LABEL[source]}</span>
              <span className="font-semibold text-white">{hidden ? '****' : `${ethFromWei(earnings?.[source] ?? '0')} ETH`}</span>
            </div>
            {needPin === source ? (
              <input
                className="input"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                aria-label="PIN"
                placeholder="PIN"
                value={pin}
                onChange={(e) => setPin(e.target.value.trim())}
                disabled={busy != null}
              />
            ) : null}
            <button
              type="button"
              className="btn btn-primary w-full py-2 text-sm"
              disabled={busy != null || (needPin === source && !pin)}
              onClick={() => void withdraw(source)}
            >
              {busy === source ? 'Withdrawing...' : 'Withdraw to my wallet'}
            </button>
          </li>
        ))}
      </ul>
      {msg ? (
        <div className={`alert ${msg.ok ? 'alert-ok' : 'alert-error'} mt-[9px] text-sm`} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </div>
      ) : null}
    </AppCard>
  );
}
