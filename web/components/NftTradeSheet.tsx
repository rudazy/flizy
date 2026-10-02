'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parseEther } from 'ethers';
import { PasswordField } from './PasswordField';
import { useDashboard } from './DashboardProvider';
import { CloseIcon, EthDiamondIcon } from './ExploreIcons';
import { bpsLabel, ethFromWei, usdLabel } from '../lib/nftFormat';

/** What the sheet is asked to do. Amounts the page already knows are in wei. */
export type TradeIntent =
  | { action: 'buy'; collection: string; tokenId: string; name: string; priceWei: string }
  | { action: 'list'; collection: string; tokenId: string; name: string; currentWei?: string | null }
  | { action: 'cancel'; collection: string; tokenId: string; name: string }
  | { action: 'offer'; collection: string; tokenId: string | null; name: string }
  | { action: 'offer-accept'; offerId: string; tokenId: string; name: string; amountWei: string }
  | { action: 'offer-cancel'; offerId: string; name: string; amountWei: string }
  | { action: 'withdraw'; amountWei: string }
  | { action: 'royalty'; collection: string; name: string; currentBps: number };

const DURATIONS = [1, 3, 7, 30, 90] as const;

const TITLES: Record<TradeIntent['action'], string> = {
  buy: 'Buy',
  list: 'List for sale',
  cancel: 'Cancel listing',
  offer: 'Make an offer',
  'offer-accept': 'Accept offer',
  'offer-cancel': 'Cancel offer',
  withdraw: 'Withdraw sale proceeds',
  royalty: 'Creator royalty',
};

const FEE_BPS = 200n;
const MAX_ROYALTY_BPS = 1000n;

function weiOf(text: string): bigint | null {
  if (!/^[0-9]{1,7}(\.[0-9]{1,18})?$/.test(text.trim())) return null;
  try {
    const wei = parseEther(text.trim());
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}

function Row({ label, value, strong = false }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 font-sans text-[12px]">
      <span className="text-[#a9a9a9]">{label}</span>
      <span className={strong ? 'font-semibold text-white' : 'text-[#e6e6e6]'}>{value}</span>
    </div>
  );
}

function Eth({ wei }: { wei: bigint | string | null }) {
  const text = ethFromWei(wei == null ? null : wei.toString());
  return (
    <span className="inline-flex items-center gap-[4px]">
      <EthDiamondIcon size={11} className="text-[#cfcfcf]" />
      {text ?? '-'} ETH
    </span>
  );
}

/**
 * Bottom sheet for every marketplace action. Shows the full split (price, the
 * 2% Flizy fee, the creator royalty, what lands where), takes the account
 * password, and posts to /api/market/[action].
 */
export function NftTradeSheet({
  intent,
  royaltyBps,
  usdPerEth,
  network,
  onClose,
  onDone,
}: {
  intent: TradeIntent;
  royaltyBps: number;
  usdPerEth: number | null;
  network: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { refreshAll } = useDashboard();
  const [amount, setAmount] = useState(() =>
    intent.action === 'list' && intent.currentWei ? ethFromWei(intent.currentWei)?.replace(/,/g, '') || '' : ''
  );
  const [days, setDays] = useState<number>(7);
  const [bps, setBps] = useState(intent.action === 'royalty' ? String(intent.currentBps / 100) : '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ explorerUrl: string; label: string } | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const typed = intent.action === 'list' || intent.action === 'offer' ? weiOf(amount) : null;
  const price: bigint | null =
    intent.action === 'buy'
      ? BigInt(intent.priceWei)
      : intent.action === 'offer-accept' || intent.action === 'offer-cancel' || intent.action === 'withdraw'
        ? BigInt(intent.amountWei)
        : typed;
  const capped = BigInt(Math.min(royaltyBps, Number(MAX_ROYALTY_BPS)));
  const fee = price != null ? (price * FEE_BPS) / 10_000n : null;
  const royalty = price != null ? (price * capped) / 10_000n : null;
  const sellerGets = price != null && fee != null && royalty != null ? price - fee - royalty : null;
  const royaltyInput = Number(bps);
  const royaltyValid = intent.action !== 'royalty' || (/^[0-9]{1,2}(\.[0-9]{1,2})?$/.test(bps.trim()) && royaltyInput <= 10);

  const needsAmount = intent.action === 'list' || intent.action === 'offer';
  const ready = !busy && !!password && (!needsAmount || typed != null) && royaltyValid;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError('');
    const body: Record<string, unknown> = { password };
    if (intent.action === 'buy') Object.assign(body, { collection: intent.collection, tokenId: intent.tokenId, priceWei: intent.priceWei });
    if (intent.action === 'list') Object.assign(body, { collection: intent.collection, tokenId: intent.tokenId, priceEth: amount.trim(), days });
    if (intent.action === 'cancel') Object.assign(body, { collection: intent.collection, tokenId: intent.tokenId });
    if (intent.action === 'offer') Object.assign(body, { collection: intent.collection, tokenId: intent.tokenId, amountEth: amount.trim(), days });
    // The royalty shown above is the most the sale may pay; the contract reverts if it rose since.
    if (intent.action === 'offer-accept') {
      Object.assign(body, { offerId: intent.offerId, tokenId: intent.tokenId, amountWei: intent.amountWei, maxRoyaltyBps: Number(capped) });
    }
    if (intent.action === 'offer-cancel') Object.assign(body, { offerId: intent.offerId });
    if (intent.action === 'royalty') Object.assign(body, { collection: intent.collection, bps: Math.round(royaltyInput * 100) });
    try {
      const res = await fetch(`/api/market/${intent.action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'That did not go through.');
        return;
      }
      setPassword('');
      setDone({ explorerUrl: data.explorerUrl, label: data.label });
      onDone();
      refreshAll().catch(() => undefined);
    } catch {
      setError('That did not go through.');
    } finally {
      setBusy(false);
    }
  }

  const name = 'name' in intent ? intent.name : 'Sale proceeds';

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 backdrop-blur-[2px]" role="presentation" onClick={() => !busy && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={TITLES[intent.action]}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-[14px] border border-b-0 border-[#26272c] bg-[#101012] px-[18px] pb-[max(18px,env(safe-area-inset-bottom))] pt-[14px] outline-none"
      >
        <div className="mx-auto mb-[12px] h-[4px] w-[38px] rounded-full bg-[#2c2d33]" aria-hidden />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="m-0 font-sans text-[16px] font-bold text-white">{TITLES[intent.action]}</h2>
            <p className="m-0 mt-[2px] truncate font-sans text-[12px] text-[#a9a9a9]">{name}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="hit-44 flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[#1a1a1d] text-[#d9d9d9]">
            <CloseIcon size={14} />
          </button>
        </div>

        {done ? (
          <div className="mt-[16px] grid gap-[12px]">
            <p className="m-0 font-sans text-[13px] text-white">{done.label}. Done.</p>
            <a href={done.explorerUrl} target="_blank" rel="noreferrer noopener" className="font-sans text-[12px] text-sun no-underline">
              View the transaction
            </a>
            <button type="button" onClick={onClose} className="btn-sun h-[42px] rounded-[6px] font-sans text-[13px]">
              Close
            </button>
          </div>
        ) : (
          <div className="mt-[16px] grid gap-[14px]">
            {needsAmount ? (
              <label className="grid gap-[6px]">
                <span className="font-sans text-[11px] uppercase tracking-wide text-[#a9a9a9]">
                  {intent.action === 'list' ? 'Price' : 'Your offer'}
                </span>
                <div className="flex items-center gap-[8px] rounded-[6px] border border-[#2a2b30] bg-[#0b0b0c] px-[12px]">
                  <EthDiamondIcon size={14} className="text-[#cfcfcf]" />
                  <input
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="h-[44px] min-w-0 flex-1 bg-transparent font-sans text-[16px] text-white outline-none"
                  />
                  <span className="font-sans text-[12px] text-[#a9a9a9]">ETH</span>
                </div>
                {typed != null && usdLabel(typed, usdPerEth) ? (
                  <span className="font-sans text-[11px] text-[#8d8d8d]">{usdLabel(typed, usdPerEth)}</span>
                ) : null}
              </label>
            ) : null}

            {needsAmount ? (
              <div className="grid gap-[6px]">
                <span className="font-sans text-[11px] uppercase tracking-wide text-[#a9a9a9]">Open for</span>
                <div className="grid grid-cols-5 gap-[6px]" role="radiogroup" aria-label="Duration">
                  {DURATIONS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      role="radio"
                      aria-checked={days === d}
                      onClick={() => setDays(d)}
                      className={`h-[36px] rounded-[6px] border font-sans text-[12px] ${
                        days === d ? 'border-sun text-sun' : 'border-[#2a2b30] text-[#cfcfcf]'
                      }`}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {intent.action === 'royalty' ? (
              <label className="grid gap-[6px]">
                <span className="font-sans text-[11px] uppercase tracking-wide text-[#a9a9a9]">Royalty on each sale (0 to 10%)</span>
                <div className="flex items-center gap-[8px] rounded-[6px] border border-[#2a2b30] bg-[#0b0b0c] px-[12px]">
                  <input
                    inputMode="decimal"
                    value={bps}
                    onChange={(e) => setBps(e.target.value)}
                    className="h-[44px] min-w-0 flex-1 bg-transparent font-sans text-[16px] text-white outline-none"
                  />
                  <span className="font-sans text-[12px] text-[#a9a9a9]">%</span>
                </div>
                <span className="font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
                  Paid to your wallet from every sale on Flizy, after the 2% Flizy fee. Traders see it before they buy.
                </span>
              </label>
            ) : null}

            {price != null &&
            intent.action !== 'royalty' &&
            intent.action !== 'withdraw' &&
            intent.action !== 'cancel' &&
            intent.action !== 'offer-cancel' ? (
              <div className="grid gap-[7px] rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[12px]">
                {intent.action === 'buy' || intent.action === 'offer' ? (
                  <>
                    <Row label={intent.action === 'buy' ? 'Price' : 'Offer'} value={<Eth wei={price} />} strong />
                    <Row label="Flizy fee (2%)" value="Paid by the seller" />
                    <Row label={`Creator royalty (${bpsLabel(Number(capped))})`} value={Number(capped) ? 'Paid by the seller' : 'None'} />
                    <div className="my-[2px] h-px bg-[#23242a]" />
                    <Row label="You pay" value={<Eth wei={price} />} strong />
                  </>
                ) : (
                  <>
                    <Row label="Sale price" value={<Eth wei={price} />} />
                    <Row label="Flizy fee (2%)" value={<Eth wei={fee} />} />
                    <Row label={`Creator royalty (${bpsLabel(Number(capped))})`} value={<Eth wei={royalty} />} />
                    <div className="my-[2px] h-px bg-[#23242a]" />
                    <Row label="You receive" value={<Eth wei={sellerGets} />} strong />
                  </>
                )}
                {usdLabel(price, usdPerEth) ? (
                  <p className="m-0 font-sans text-[10.5px] text-[#7d7d7d]">
                    {usdLabel(price, usdPerEth)} at the mainnet ETH price. This is {network} testnet ETH.
                  </p>
                ) : null}
              </div>
            ) : null}

            {intent.action === 'offer' ? (
              <p className="m-0 font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
                Your ETH is held by the marketplace contract until the offer is accepted, or you cancel it. You can cancel any time.
              </p>
            ) : null}
            {intent.action === 'list' ? (
              <p className="m-0 font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
                The NFT stays in your wallet until it sells. Listing also approves the marketplace for this one NFT, and moving it ends the listing. The royalty can never be more than the rate shown now.
              </p>
            ) : null}
            {intent.action === 'withdraw' ? (
              <Row label="Amount" value={<Eth wei={price} />} strong />
            ) : null}
            {intent.action === 'offer-cancel' ? (
              <>
                <Row label="Back to your wallet" value={<Eth wei={price} />} strong />
                <p className="m-0 font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
                  The full amount of the offer is returned. No fee is taken. Network gas is paid from your wallet.
                </p>
              </>
            ) : null}

            <PasswordField label="Account password" value={password} onChange={setPassword} autoComplete="current-password" />
            {error ? <p className="alert alert-error m-0">{error}</p> : null}
            <button type="button" onClick={submit} disabled={!ready} className="btn-sun h-[44px] rounded-[6px] font-sans text-[13.5px] disabled:opacity-50">
              {busy ? 'Confirming...' : `Confirm ${TITLES[intent.action].toLowerCase()}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
