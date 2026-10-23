'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { PinField, pinReady } from './PinField';
import { txPin } from '../lib/txPin';
import { withinQuickSend } from '../lib/quickSend';
import { PAY_ASSETS, type PayAsset } from '../lib/payAsset';
import { listedBySymbol, symbolLabel } from '../lib/listedTokens';
import { FLZ_TOKEN } from '../lib/walletChain';
import type { PayPreset } from '../lib/payLink';
import { ShareReceiptButton } from './ShareReceiptButton';
import { ExternalPay } from './ExternalPay';
import {
  ArrowRightIcon,
  CloseIcon,
  CopyIcon,
  EthDiamondIcon,
  ExternalLinkIcon,
  EyeIcon,
  GiwaMarkIcon,
  InfoIcon,
  RefreshIcon,
} from './ExploreIcons';

/** A sensible example amount per asset, shown as the input placeholder. */
const PLACEHOLDER: Record<PayAsset, string> = { ETH: '0.01', FLZ: '10', TUSD: '20' };

/** ETH kept back on Max, so the payment itself can still pay its gas. */
const ETH_GAS_RESERVE = 0.0005;

const NETWORK = 'GIWA (Ethereum)';

const CARD_BG = { background: 'radial-gradient(80% 45% at 75% 0%, rgba(70, 52, 14, 0.4) 0%, rgba(16, 15, 13, 0) 70%), #0f0f10' };

/** tUSD reads as dollars and cents; ETH and tokens keep up to six places. */
function shown(amount: string, asset: PayAsset): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return asset === 'TUSD'
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function usd(value: number): string {
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 6)}...${hash.slice(-8)}` : hash;
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

export function PayLanding({
  refSlug,
  username,
  displayName,
  preset = null,
  outsidePay = false,
}: {
  refSlug: string;
  username: string | null;
  displayName: string | null;
  /** From the link: a suggested amount, asset and note. The payer still reviews and confirms. */
  preset?: PayPreset | null;
  /** The owner lets wallets outside Flizy pay this link (accounts.accept_outside_pay). */
  outsidePay?: boolean;
}) {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [self, setSelf] = useState(false);
  const [payerHandle, setPayerHandle] = useState('');
  const [amount, setAmount] = useState(preset?.amount ?? '');
  const [asset, setAsset] = useState<PayAsset>(preset?.asset ?? 'ETH');
  /** Already flattened and capped by parsePayPreset; the server cleans it again. */
  const note = preset?.note ?? null;
  const unit = symbolLabel(asset);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const [explorer, setExplorer] = useState('');
  const [txHash, setTxHash] = useState('');
  const [transferId, setTransferId] = useState('');
  const [firstPay, setFirstPay] = useState(false);
  const [alreadySaved, setAlreadySaved] = useState(true);
  /** From the preview: paid before, and the most a payment may be without the PIN. */
  const [known, setKnown] = useState(false);
  const [quickSendEth, setQuickSendEth] = useState('0');
  /** The server asked for the PIN on a payment the page thought was quick. */
  const [pinAsked, setPinAsked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSkipped, setSaveSkipped] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [savePassword, setSavePassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  /** Enter the amount, then review it, then pay. Nothing moves before Confirm. */
  const [stage, setStage] = useState<'edit' | 'review'>('edit');
  /** The payer's Flizy wallet, for Balance and Max. Null until read, and when it cannot be. */
  const [balances, setBalances] = useState<Record<PayAsset, string> | null>(null);
  const [usdPerEth, setUsdPerEth] = useState<number | null>(null);
  const [flzEth, setFlzEth] = useState<number | null>(null);

  const handle = username ? `@${username}` : 'this Flizy account';
  // Sign-in returns to the same ask, not to an empty form.
  const presetQuery = new URLSearchParams({
    ...(preset?.amount ? { amount: preset.amount } : {}),
    ...(preset && preset.asset !== 'ETH' ? { asset: preset.asset.toLowerCase() } : {}),
    ...(note ? { for: note } : {}),
  }).toString();
  const next = `/pay/${encodeURIComponent(refSlug)}${presetQuery ? `?${presetQuery}` : ''}`;
  const amountOk = Number(amount) > 0;
  /** Pay a token amount with ETH (POST /api/pay/swap). Off until the payer asks for it. */
  const [withEth, setWithEth] = useState(false);
  const [ethQuote, setEthQuote] = useState<{ maxEth: string } | null>(null);
  // With the transaction PIN off (web/lib/txPin.ts) no payment asks for it.
  // With it on, paying with ETH always does, and so does anything past quick send.
  const needsPin =
    txPin.required && (withEth || pinAsked || !(asset === 'ETH' && known && withinQuickSend(amount, quickSendEth)));

  /** Dollars for one unit of the chosen asset, or null when it cannot be priced. tUSD is one dollar. */
  const usdPerUnit = asset === 'TUSD' ? 1 : asset === 'ETH' ? usdPerEth : flzEth != null && usdPerEth != null ? flzEth * usdPerEth : null;
  const dollars = amountOk && usdPerUnit != null ? Number(amount) * usdPerUnit : null;
  const balance = balances ? balances[asset] : null;
  const maxAmount = balance == null ? null : asset === 'ETH' ? Math.max(0, Number(balance) - ETH_GAS_RESERVE) : Number(balance);

  async function quoteWithEth() {
    setMsg('');
    setEthQuote(null);
    try {
      const res = await fetch(`/api/pay/swap?asset=${asset}&amount=${encodeURIComponent(amount)}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.maxEth !== 'string') {
        setMsg(typeof body.error === 'string' ? body.error : 'Could not price this in ETH.');
        setWithEth(false);
        return;
      }
      setEthQuote({ maxEth: body.maxEth });
      setWithEth(true);
    } catch {
      setMsg('Could not price this in ETH.');
      setWithEth(false);
    }
  }

  useEffect(() => {
    let live = true;
    // The preview alone says signed in or not, own page or not, and first
    // payment or not, so the form and its warning wait on nothing else.
    fetch(`/api/pay/preview?ref=${encodeURIComponent(refSlug)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!live) return;
        if (res.status === 401) {
          setLoggedIn(false);
          return;
        }
        const info = await res.json().catch(() => ({}));
        if (!live) return;
        setLoggedIn(true);
        if (res.ok) {
          if (info.self) {
            setSelf(true);
            return;
          }
          setFirstPay(Boolean(info.firstPay));
          setAlreadySaved(Boolean(info.alreadySaved));
          setKnown(info.known === true);
          setQuickSendEth(typeof info.quickSendEth === 'string' ? info.quickSendEth : '0');
          setUsdPerEth(typeof info.usdPerEth === 'number' ? info.usdPerEth : null);
        }
      })
      .catch(() => live && setLoggedIn(false));
    // Only for the "Signed in as" line; the form does not wait for it.
    fetch('/api/dashboard', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok || !live) return;
        const body = await res.json().catch(() => ({}));
        const mine = String(body?.account?.username || '').toLowerCase();
        if (live && mine) setPayerHandle(`@${mine}`);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refSlug]);

  /** The payer's Flizy wallet balances, from the same read the wallet page uses. */
  const loadBalances = useCallback(async () => {
    try {
      const res = await fetch('/api/holdings', { cache: 'no-store' });
      if (!res.ok) throw new Error('unavailable');
      const body = await res.json();
      const tokens = Array.isArray(body?.holdings?.tokens) ? (body.holdings.tokens as Array<{ address?: string; balance?: string | null }>) : [];
      const of = (address: string | undefined) =>
        (address && tokens.find((t) => String(t.address || '').toLowerCase() === address.toLowerCase())?.balance) || '0';
      setBalances({
        ETH: String(body?.holdings?.native?.balance ?? '0'),
        FLZ: of(FLZ_TOKEN),
        TUSD: of(listedBySymbol('TUSD')?.address),
      });
    } catch {
      // No balance shown is better than a wrong one; the payment still works.
      setBalances(null);
    }
  }, []);

  useEffect(() => {
    if (loggedIn && !self) void loadBalances();
  }, [loggedIn, self, loadBalances]);

  // FLZ is priced from its pool, in ETH; the dollar line multiplies through.
  useEffect(() => {
    if (asset !== 'FLZ' || flzEth != null || !loggedIn) return;
    fetch('/api/swap/quote?price=1&token=FLZ', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const px = Number(body?.price?.ethPerToken);
        if (Number.isFinite(px) && px > 0) setFlzEth(px);
      })
      .catch(() => undefined);
  }, [asset, flzEth, loggedIn]);

  function fillMax() {
    if (maxAmount == null || maxAmount <= 0 || balance == null) return;
    // Tokens go in full, as read; ETH rounds down so the reserve is kept.
    setAmount(asset === 'ETH' ? (Math.floor(maxAmount * 1e6) / 1e6).toString() : balance);
  }

  function onReview(e: React.FormEvent) {
    e.preventDefault();
    if (!amountOk) {
      setMsg('Enter an amount above 0.');
      return;
    }
    setMsg('');
    setStage('review');
  }

  async function onPay() {
    if ((needsPin && !pinReady(pin)) || busy) return;
    setBusy(true);
    setMsg('');
    setOk(false);
    try {
      const res = withEth && ethQuote
        ? await fetch('/api/pay/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: refSlug, amount, pin, asset, note, maxEth: ethQuote.maxEth }),
          })
        : await fetch('/api/pay/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: refSlug, amount, pin: needsPin ? pin : '', asset, note }),
          });
      const body = await res.json().catch(() => ({}));
      // A wrong PIN is a 401 too; only a missing session (no code) means sign in.
      if (res.status === 401 && !body.code) {
        window.location.href = `/login?next=${encodeURIComponent(next)}`;
        return;
      }
      if (body.code === 'PIN_REQUIRED') setPinAsked(true);
      if (!res.ok) {
        setMsg(body.error || 'Could not pay.');
        return;
      }
      setOk(true);
      setExplorer(body.explorerUrl || '');
      setTxHash(typeof body.txHash === 'string' ? body.txHash : '');
      setTransferId(typeof body.transferId === 'string' ? body.transferId : '');
      setPin('');
      if (body.alreadySaved === true) setAlreadySaved(true);
      else setAlreadySaved(false);
    } catch {
      setMsg('Could not pay. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const fromLabel = payerHandle ? `${payerHandle}, Flizy wallet` : 'Your Flizy wallet';
  const paid = loggedIn && !self && ok;

  return (
    <div className="fade-up mx-auto w-full max-w-[560px]">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 rounded-[18px] border border-[#3a3017] px-4 py-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:px-6" style={CARD_BG}>
        {paid ? (
          <PaidHeader amount={amount} unit={unit} handle={handle} />
        ) : (
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <p className="m-0 font-mono text-[12px] uppercase tracking-[0.22em] text-sun">Send payment to</p>
              <div className="mt-4 flex items-start gap-3.5">
                <span className="flex h-[58px] w-[58px] shrink-0 items-center justify-center rounded-full border border-[#5a4718] bg-[#14110a] font-sans text-[28px] font-bold text-sun">
                  @
                </span>
                <div className="min-w-0">
                  <h1 className="m-0 break-words font-sans text-[26px] font-bold leading-tight text-white">{displayName || handle}</h1>
                  {displayName && username ? <p className="m-0 font-mono text-[13px] text-[#9a958c]">@{username}</p> : null}
                  <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[#1f6b45] bg-[#0f2a1d] px-2.5 py-1 font-sans text-[12px] text-[#3ddc84]">
                    <CheckDot />
                    Flizy user
                  </span>
                  {loggedIn && !self ? (
                    <p className="m-0 mt-2.5 font-mono text-[12.5px] leading-relaxed text-[#9a958c]">
                      {stage === 'edit' && payerHandle ? `Signed in as ${payerHandle}. ` : ''}This send comes from your Flizy wallet.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="hidden shrink-0 flex-col items-center gap-2 rounded-[14px] border border-[#3a3017] bg-[#14110a] px-4 pb-3 pt-4 min-[400px]:flex">
              <span className="flex h-[58px] w-[58px] items-center justify-center rounded-[10px] border border-[#5a4718] text-sun">
                <QrGlyph />
              </span>
              <span className="font-mono text-[11.5px] text-sun">Flizy Pay</span>
            </div>
          </div>
        )}

        {self ? <p className="m-0 font-sans text-[13px] text-[#9a958c]">This is your pay page. Share the QR or @username.</p> : null}

        {loggedIn === false ? (
          <div className="grid gap-2">
            <Link href={`/login?next=${encodeURIComponent(next)}`} className="btn btn-primary py-3 font-sans no-underline">
              Log in to pay
            </Link>
            <Link href={`/signup?next=${encodeURIComponent(next)}`} className="btn btn-ghost py-3 font-sans no-underline">
              Create account
            </Link>
          </div>
        ) : null}

        {loggedIn === false && outsidePay ? (
          <ExternalPay refSlug={refSlug} presetAmount={preset?.amount ?? null} presetAsset={preset?.asset ?? 'ETH'} note={note} handle={handle} />
        ) : null}

        {loggedIn && !self && !ok && stage === 'edit' ? (
          <form onSubmit={onReview} className="grid gap-5">
            {firstPay ? <FirstPayNote handle={handle} /> : null}
            {note ? (
              <p className="m-0 font-sans text-[13px] text-[#9a958c]">
                For: <span className="break-words text-white">{note}</span>
                <span className="block text-[11.5px]">Written by whoever made this link.</span>
              </p>
            ) : null}

            <div className="grid gap-3 rounded-[14px] border border-[#26262a] bg-[#0c0c0d] px-3.5 py-4">
              <div className="flex items-center justify-between gap-2">
                <p className="m-0 font-mono text-[13px] font-semibold uppercase tracking-[0.08em] text-white" id="pay-asset-label">
                  Select asset
                </p>
                <span className="flex items-center gap-2 font-mono text-[12px] text-[#9a958c]">
                  {balance != null ? `Balance: ${shown(balance, asset)} ${unit}` : 'Balance: ...'}
                  <button type="button" aria-label="Refresh balance" className="inline-flex text-[#b7b1a8] hover:text-white" onClick={() => void loadBalances()}>
                    <RefreshIcon size={15} />
                  </button>
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2" role="group" aria-labelledby="pay-asset-label">
                {PAY_ASSETS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    aria-pressed={asset === opt}
                    onClick={() => setAsset(opt)}
                    className={`flex h-[54px] items-center justify-center gap-2.5 rounded-[10px] border font-sans text-[15px] font-semibold text-white transition-colors ${
                      asset === opt ? 'border-sun bg-[#2a210a]' : 'border-[#2a2b30] bg-[#111113] hover:border-[#3a3a3e]'
                    }`}
                  >
                    <AssetIcon asset={opt} size={30} />
                    {symbolLabel(opt)}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-2.5">
              <div className="flex items-center justify-between gap-2">
                <label className="font-mono text-[13px] font-semibold uppercase tracking-[0.08em] text-white" htmlFor="pay-amount">
                  Amount ({unit})
                </label>
                <button
                  type="button"
                  className="rounded-full border border-sun/80 px-4 py-1 font-sans text-[13px] font-semibold text-sun disabled:opacity-40"
                  onClick={fillMax}
                  disabled={maxAmount == null || maxAmount <= 0}
                >
                  Max
                </button>
              </div>
              <div className="flex h-[60px] items-center gap-3 rounded-[12px] border border-sun/70 bg-[#0c0c0d] pl-3 pr-3 shadow-[0_0_0_1px_rgba(247,208,71,0.08)]">
                <AssetIcon asset={asset} size={34} />
                <input
                  id="pay-amount"
                  className="h-full w-0 min-w-0 flex-1 bg-transparent font-sans text-[18px] text-white outline-none placeholder:text-[#4a4a4a]"
                  inputMode="decimal"
                  placeholder={PLACEHOLDER[asset]}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
                {dollars != null ? <span className="shrink-0 font-mono text-[13px] text-[#9a958c]">≈ {usd(dollars)}</span> : null}
                {amount ? (
                  <button
                    type="button"
                    aria-label="Clear amount"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#2a2a2c] text-[#b7b1a8] hover:text-white"
                    onClick={() => setAmount('')}
                  >
                    <CloseIcon size={14} />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-3 divide-x divide-[#26262a] rounded-[12px] border border-[#26262a] bg-[#0c0c0d] py-3.5">
              <div className="min-w-0 px-3">
                <p className="m-0 font-mono text-[11.5px] text-[#8d867c]">You send</p>
                <p className="m-0 mt-1 truncate font-sans text-[16px] font-semibold text-white">
                  {amountOk ? shown(amount, asset) : '0'} {unit}
                </p>
                {dollars != null ? <p className="m-0 font-mono text-[11.5px] text-[#8d867c]">≈ {usd(dollars)}</p> : null}
              </div>
              <div className="min-w-0 px-3">
                <p className="m-0 font-mono text-[11.5px] text-[#8d867c]">To</p>
                <p className="m-0 mt-1.5 flex items-center gap-1.5 font-sans text-[14.5px] font-semibold text-white">
                  <span className="truncate">{handle}</span>
                  <CopyButton text={handle} label="Copy recipient" />
                </p>
              </div>
              <div className="min-w-0 px-3">
                <p className="m-0 font-mono text-[11.5px] text-[#8d867c]">Network</p>
                <p className="m-0 mt-1.5 flex items-center gap-1.5 font-mono text-[13px] text-[#d9d4ca]">
                  <NetworkMark size={22} />
                  GIWA
                  <span title="GIWA Sepolia, an Ethereum layer 2 testnet" className="inline-flex text-[#8d867c]">
                    <InfoIcon size={14} />
                  </span>
                </p>
              </div>
            </div>

            {msg ? <div className="alert alert-error text-sm">{msg}</div> : null}
            <button type="submit" className="btn btn-primary flex w-full items-center justify-center gap-2.5 py-4 font-sans text-[16px] font-semibold" disabled={!amountOk}>
              Review payment to {handle}
              <ArrowRightIcon size={18} />
            </button>
          </form>
        ) : null}

        {loggedIn && !self && !ok && stage === 'review' ? (
          <div className="grid gap-4">
            {firstPay ? <FirstPayNote handle={handle} review /> : null}
            <div className="rounded-[14px] border border-[#26262a] bg-[#0c0c0d] px-4 pb-1 pt-4">
              <p className="m-0 pb-3 font-mono text-[14px] font-semibold uppercase tracking-[0.08em] text-white">Review payment</p>
              <dl className="m-0">
                <Row name="To" copyText={handle}>
                  {displayName ? `${displayName} ` : ''}
                  {handle}
                </Row>
                <Row name="Amount" copyText={`${amount} ${unit}`}>
                  {amount} {unit}
                </Row>
                {note ? (
                  <Row name="For">
                    <span className="break-words">{note}</span>
                  </Row>
                ) : null}
                <Row name="From">
                  {fromLabel}
                </Row>
                {withEth && ethQuote ? (
                  <Row name="You pay">
                    up to {ethQuote.maxEth} ETH
                  </Row>
                ) : null}
                <Row name="Network">
                  <span className="inline-flex items-center justify-end gap-2">
                    <NetworkMark size={20} />
                    {NETWORK}
                  </span>
                </Row>
                <Row name="Network fee" info="Gas for this payment is paid in ETH from your Flizy wallet." last>
                  Paid in ETH from your wallet
                </Row>
              </dl>
            </div>

            {asset !== 'ETH' ? (
              <label className="flex cursor-pointer items-start gap-3.5 rounded-[14px] border border-[#5a4718] bg-[#14110a] px-4 py-4">
                <input
                  type="checkbox"
                  className="mt-1 h-[18px] w-[18px] shrink-0 accent-sun"
                  checked={withEth}
                  disabled={busy}
                  onChange={(e) => (e.target.checked ? void quoteWithEth() : (setWithEth(false), setEthQuote(null)))}
                />
                <span className="font-sans">
                  <span className="block text-[15px] text-white">Pay with ETH instead</span>
                  <span className="mt-1 block text-[13.5px] leading-relaxed text-[#9a958c]">
                    Your ETH is swapped and {handle} receives at least {amount} {unit}. Anything over that from the price moving
                    goes to them.
                  </span>
                </span>
              </label>
            ) : null}

            {needsPin ? (
              <PinField id="pay-pin" value={pin} onChange={setPin} />
            ) : txPin.required ? (
              <p className="text-sm text-muted">Quick send: no PIN for up to {quickSendEth} ETH to someone you have paid before.</p>
            ) : null}
            {msg ? <div className="alert alert-error text-sm">{msg}</div> : null}
            <div className="grid grid-cols-[auto_1fr] gap-3">
              <button
                type="button"
                className="btn btn-ghost px-7 py-4 font-sans text-[15px] sm:px-12"
                disabled={busy}
                onClick={() => {
                  setPin('');
                  setMsg('');
                  setWithEth(false);
                  setEthQuote(null);
                  setStage('edit');
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary flex items-center justify-center gap-2 whitespace-nowrap py-4 font-sans text-[15px] font-semibold"
                disabled={busy || (needsPin && !pinReady(pin))}
                onClick={() => void onPay()}
              >
                {busy ? 'Paying…' : `Confirm and pay ${amount} ${unit}`}
                {busy ? null : <ArrowRightIcon size={18} />}
              </button>
            </div>
          </div>
        ) : null}

        {paid ? (
          <div className="grid gap-4">
            <div className="rounded-[14px] border border-[#26262a] bg-[#0c0c0d] px-3.5 pb-1 pt-2">
              <dl className="m-0">
                <Row name="To" copyText={handle}>
                  {handle}
                </Row>
                <Row name="Amount" copyText={`${amount} ${unit}`}>
                  <span className="block">
                    {amount} {unit}
                  </span>
                  {dollars != null ? <span className="block font-mono text-[12px] text-[#8d867c]">≈ {usd(dollars)}</span> : null}
                </Row>
                <Row name="From" copyText={fromLabel}>
                  {fromLabel}
                </Row>
                <Row name="Network" copyText={NETWORK}>
                  <span className="inline-flex items-center justify-end gap-2">
                    <NetworkMark size={20} />
                    {NETWORK}
                  </span>
                </Row>
                {txHash ? (
                  <Row name="Transaction" href={explorer || undefined} last>
                    <span className="font-mono">{shortHash(txHash)}</span>
                  </Row>
                ) : null}
              </dl>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {explorer ? (
                <a
                  href={explorer}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-2 rounded-[10px] border border-sun/70 py-3 font-sans text-[14.5px] font-semibold text-sun no-underline hover:bg-[#1c180c]"
                >
                  <ExternalLinkIcon size={17} />
                  View on explorer
                </a>
              ) : null}
              {transferId ? (
                <ShareReceiptButton
                  transferId={transferId}
                  wide
                  className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-sun/70 py-3 font-sans text-[14.5px] font-semibold text-sun hover:bg-[#1c180c] disabled:opacity-60"
                />
              ) : null}
            </div>

            {justSaved ? (
              <div className="alert alert-ok text-sm">Saved {handle} for later send.</div>
            ) : !alreadySaved && !saveSkipped ? (
              <div className="grid gap-4 rounded-[14px] border border-[#3a3017] bg-[#14110a] px-4 py-5">
                <div>
                  <p className="m-0 font-sans text-[16px] font-semibold text-white">Save {handle} as a trusted contact</p>
                  <p className="m-0 mt-0.5 font-sans text-[13.5px] text-[#9a958c]">So the next send is just their name.</p>
                </div>
                <div className="grid gap-2">
                  <label className="font-mono text-[12px] font-semibold uppercase tracking-[0.1em] text-[#b7b1a8]" htmlFor="save-password">
                    Account password
                  </label>
                  <div className="flex h-[52px] items-center gap-3 rounded-[10px] border border-[#2a2b30] bg-[#0c0c0d] px-3.5 focus-within:border-sun/70">
                    <span className="text-[#8d867c]">
                      <LockGlyph />
                    </span>
                    <input
                      id="save-password"
                      className="h-full min-w-0 flex-1 bg-transparent font-sans text-[14px] text-white outline-none placeholder:text-[#6a6a6a]"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      placeholder="Enter your account password"
                      value={savePassword}
                      onChange={(e) => setSavePassword(e.target.value)}
                      required
                    />
                    <button
                      type="button"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                      className="inline-flex text-[#b7b1a8] hover:text-white"
                      onClick={() => setShowPassword((v) => !v)}
                    >
                      <EyeIcon size={18} />
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary w-full py-3.5 font-sans font-semibold"
                  disabled={saving || !savePassword}
                  onClick={async () => {
                    setSaving(true);
                    setMsg('');
                    try {
                      const res = await fetch('/api/pay/save', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ref: refSlug, password: savePassword }),
                      });
                      const body = await res.json().catch(() => ({}));
                      if (!res.ok) throw new Error(body.error || 'Could not save');
                      setAlreadySaved(true);
                      setJustSaved(true);
                      setSavePassword('');
                    } catch (err) {
                      setMsg(err instanceof Error ? err.message : 'Could not save');
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  {saving ? 'Saving…' : `Save ${handle} for later`}
                </button>
                <button type="button" className="btn btn-ghost w-full py-3.5 font-sans" disabled={saving} onClick={() => setSaveSkipped(true)}>
                  Skip for now
                </button>
                {msg ? <div className="alert alert-error text-sm">{msg}</div> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The success header: a lit check and what was sent. */
function PaidHeader({ amount, unit, handle }: { amount: string; unit: string; handle: string }) {
  return (
    <div className="grid justify-items-center gap-2 pt-1 text-center">
      <span className="relative flex h-[86px] w-[86px] items-center justify-center rounded-full bg-[#0f2a1d] shadow-[0_0_40px_rgba(61,220,132,0.22)]" aria-hidden>
        <span className="flex h-[66px] w-[66px] items-center justify-center rounded-full border-[3px] border-[#3ddc84]">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#3ddc84" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
      </span>
      <h1 className="m-0 font-sans text-[28px] font-bold text-white">Payment successful!</h1>
      <p className="m-0 font-sans text-[16px] text-[#b7b1a8]">
        You&apos;ve sent {amount} {unit} to {handle}.
      </p>
    </div>
  );
}

/** One line of the review or the paid list: a name, the value, and a copy or open button. */
function Row({
  name,
  children,
  copyText,
  href,
  info,
  last = false,
}: {
  name: string;
  children: ReactNode;
  copyText?: string;
  href?: string;
  info?: string;
  last?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 py-3.5 ${last ? '' : 'border-b border-[#1f1f22]'}`}>
      <dt className="w-[108px] shrink-0 font-sans text-[14.5px] text-[#9a958c]">{name}</dt>
      <dd className="m-0 min-w-0 flex-1 text-right font-sans text-[15px] text-white">{children}</dd>
      {copyText ? <CopyButton text={copyText} label={`Copy ${name.toLowerCase()}`} /> : null}
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" aria-label="Open on explorer" className="inline-flex shrink-0 text-[#d9d4ca] hover:text-white">
          <ExternalLinkIcon size={18} />
        </a>
      ) : null}
      {info ? (
        <span title={info} className="inline-flex shrink-0 text-[#9a958c]">
          <InfoIcon size={18} />
        </span>
      ) : null}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      className={`inline-flex shrink-0 ${copied ? 'text-[#3ddc84]' : 'text-[#9a958c] hover:text-white'}`}
      onClick={() => {
        copy(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      <CopyIcon size={17} />
    </button>
  );
}

function FirstPayNote({ handle, review = false }: { handle: string; review?: boolean }) {
  return (
    <div className="rounded-[12px] border border-[#5a4718] bg-[#1c1608] px-4 py-3 font-sans text-[13px] leading-relaxed text-[#e0b070]">
      First payment. You have not paid {handle} before.{' '}
      {review ? 'Check this is the right person before you confirm.' : 'Confirm the name before you send.'}
    </div>
  );
}

/** ETH, FLZ and tUSD marks. ETH is drawn; the tokens use their listed logos. */
function AssetIcon({ asset, size }: { asset: PayAsset; size: number }) {
  if (asset === 'ETH') {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full border border-[#3a3a3e] bg-[#1c1c1f] text-[#e6e6e6]"
        style={{ width: size, height: size }}
      >
        <EthDiamondIcon size={Math.round(size * 0.55)} />
      </span>
    );
  }
  const logo = asset === 'TUSD' ? listedBySymbol('TUSD')?.logo : '/tokens/flz.svg';
  return <img src={logo || '/tokens/flz.svg'} alt="" width={size} height={size} className="shrink-0 rounded-full" />;
}

/** GIWA's wave in a gold ring. */
function NetworkMark({ size }: { size: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full border border-[#5a4718] bg-[#14110a] text-sun"
      style={{ width: size, height: size }}
    >
      <GiwaMarkIcon size={Math.round(size * 0.58)} />
    </span>
  );
}

function CheckDot() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** A QR code inside scan corners, for the Flizy Pay tile. */
function QrGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M3 11V5a2 2 0 012-2h6M29 3h6a2 2 0 012 2v6M37 29v6a2 2 0 01-2 2h-6M11 37H5a2 2 0 01-2-2v-6" />
      <rect x="10" y="10" width="8" height="8" rx="1.2" />
      <rect x="22" y="10" width="8" height="8" rx="1.2" />
      <rect x="10" y="22" width="8" height="8" rx="1.2" />
      <path d="M22 22h3v3M30 22v8h-4M22 28v2" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 018 0v3" />
      <circle cx="12" cy="15.5" r="1.2" fill="currentColor" />
    </svg>
  );
}
