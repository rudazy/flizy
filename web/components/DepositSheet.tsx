'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useExternalWallet } from './ExternalWalletProvider';
import { ArrowRightIcon, ChevronDownIcon, CloseIcon, CopyIcon, EthDiamondIcon, WalletIcon } from './ExploreIcons';
import { listedBySymbol } from '../lib/listedTokens';
import { fromUnits as unitsText, shareOf, toUnits } from '../lib/tokenUnits';
import { GIWA, giwaClients, shortAddress, walletErrorText } from '../lib/walletChain';
import { recordOnScan, walletBalances } from '../lib/walletTrade';

/** ETH kept back from 100%, so the deposit itself can still pay its gas: 0.0005 ETH. */
const ETH_GAS_RESERVE = 5n * 10n ** 14n;

/** Decimals the amount shows and is rounded down to. */
const SHOWN_DP = 6;

const MARKS = [0, 25, 50, 75, 100];

type Choice = 'ETH' | 'TUSD';

/** As shown: rounded down to SHOWN_DP places. */
function fromUnits(units: bigint, decimals: number, dp = SHOWN_DP): string {
  return unitsText(units, decimals, dp);
}

/** An amount for reading, with thousands separators. The input keeps the plain form. */
function grouped(text: string): string {
  const [whole, frac] = text.split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${withCommas}.${frac}` : withCommas;
}

function usd(value: number): string {
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

/**
 * Deposit from the connected wallet into the Flizy wallet, as a dialog over
 * the Account page. Pick ETH or tUSD, slide to a share of what the connected
 * wallet holds (or type an amount), and the wallet asks to approve one
 * transfer. ETH keeps a little back at 100% for gas. Once it lands the hash
 * goes to Scan (recordOnScan).
 */
export function DepositSheet({
  open,
  onClose,
  flizyAddress,
  usdPerEth,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  flizyAddress: string;
  /** For the dollar line under ETH amounts; null hides it. tUSD counts as one dollar. */
  usdPerEth: number | null;
  /** Shown under the deposit button: how money goes back to this wallet. */
  footer?: ReactNode;
}) {
  const wallet = useExternalWallet();
  const own = wallet?.address ?? null;
  const tusd = listedBySymbol('TUSD');

  const [choice, setChoice] = useState<Choice>('ETH');
  const [menuOpen, setMenuOpen] = useState(false);
  const [balances, setBalances] = useState<Record<Choice, bigint> | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ url: string; text: string } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Escape, like the backdrop, does not close while a deposit waits on the wallet.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const decimals = choice === 'TUSD' && tusd ? tusd.decimals : 18;
  const label = choice === 'TUSD' ? 'tUSD' : 'ETH';

  const loadBalances = useCallback(async () => {
    if (!own) return;
    try {
      const read = await walletBalances(own, tusd ? [{ address: tusd.address, decimals: tusd.decimals }] : []);
      setBalances({
        ETH: toUnits(read.eth, 18) ?? 0n,
        TUSD: tusd ? (toUnits(read.tokens[tusd.address.toLowerCase()] ?? '0', tusd.decimals) ?? 0n) : 0n,
      });
    } catch {
      // No balance shown is better than a wrong one; a typed amount still deposits.
      setBalances(null);
    }
  }, [own, tusd]);

  // Fresh each time it opens.
  useEffect(() => {
    if (!open) return;
    setText('');
    setError('');
    setDone(null);
    setMenuOpen(false);
    setBalances(null);
    void loadBalances();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, loadBalances]);

  const balance = balances ? balances[choice] : null;
  const max = balance == null ? null : choice === 'ETH' ? (balance > ETH_GAS_RESERVE ? balance - ETH_GAS_RESERVE : 0n) : balance;
  const units = toUnits(text, decimals);
  const pct = max && units != null ? Math.min(100, Number((units * 10000n) / max) / 100) : 0;
  const amount = units != null ? Number(fromUnits(units, decimals)) : 0;
  const dollars = choice === 'TUSD' ? amount : usdPerEth != null ? amount * usdPerEth : null;
  const tooMuch = units != null && max != null && units > max;
  const canDeposit = !busy && units != null && units > 0n && !tooMuch && /^0x[0-9a-fA-F]{40}$/.test(flizyAddress);

  function setShare(share: number) {
    if (max == null) return;
    // A token goes in full at 100%; anything else rounds down to what is shown.
    const exact = shareOf(max, share);
    setText(share >= 100 && choice === 'TUSD' ? fromUnits(exact, decimals, decimals) : fromUnits(exact, decimals));
  }

  function pick(next: Choice) {
    setChoice(next);
    setMenuOpen(false);
    setText('');
    setError('');
  }

  async function deposit() {
    if (!wallet || !own || !canDeposit || units == null) return;
    setBusy(true);
    setError('');
    setDone(null);
    try {
      const provider = await wallet.provider();
      if (!provider) throw new Error('Connect your wallet again.');
      const { viem, wallet: signer, reader } = await giwaClients(provider, own);
      const to = flizyAddress as `0x${string}`;
      const hash =
        choice === 'ETH' || !tusd
          ? await signer.sendTransaction({ account: own, chain: signer.chain, to, value: units })
          : await signer.writeContract({ address: tusd.address as `0x${string}`, abi: viem.erc20Abi, functionName: 'transfer', args: [to, units] });
      const receipt = await reader.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The deposit failed on chain.');
      recordOnScan(hash);
      setDone({ url: `${GIWA.explorerUrl}/tx/${hash}`, text: `Deposited ${grouped(fromUnits(units, decimals))} ${label} into your Flizy wallet.` });
      setText('');
      void loadBalances();
    } catch (err) {
      setError(walletErrorText(err, 'The deposit did not go through.'));
    } finally {
      setBusy(false);
    }
  }

  async function change() {
    if (!wallet || busy) return;
    wallet.disconnect();
    onClose();
    await wallet.connect();
  }

  if (!open || !own) return null;

  const tokenIcon = (c: Choice, size = 30) =>
    c === 'TUSD' && tusd ? (
      <img src={tusd.logo} alt="" width={size} height={size} className="shrink-0 rounded-full" />
    ) : (
      <span
        className="flex shrink-0 items-center justify-center rounded-full border border-[#2e2e2e] bg-[#161616] text-[#e6e6e6]"
        style={{ width: size, height: size }}
      >
        <EthDiamondIcon size={Math.round(size / 2)} />
      </span>
    );

  const balanceText = (c: Choice) => {
    const b = balances ? balances[c] : null;
    return b == null ? '...' : `${Number(fromUnits(b, c === 'TUSD' && tusd ? tusd.decimals : 18)).toLocaleString(undefined, { maximumFractionDigits: SHOWN_DP })} ${c === 'TUSD' ? 'tUSD' : 'ETH'}`;
  };

  // On document.body: an animated ancestor would otherwise pin the overlay to itself.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4 backdrop-blur-[2px]" onClick={busy ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="deposit-title"
        onClick={(e) => e.stopPropagation()}
        className="relative grid max-h-[92dvh] w-full max-w-[420px] gap-4 overflow-y-auto rounded-[18px] border border-[#5a4718] px-[18px] pb-[18px] pt-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
        style={{ background: 'radial-gradient(70% 50% at 70% 0%, rgba(70, 52, 14, 0.45) 0%, rgba(16, 15, 13, 0) 70%), #101011' }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="deposit-title" className="m-0 font-sans text-[20px] font-bold leading-[24px] text-white">
              Deposit to Flizy
            </h2>
            <p className="m-0 mt-[3px] font-sans text-[13px] text-[#bdbdbd]">Move funds from your connected wallet to your Flizy wallet.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="hit-44 inline-flex text-[#b7b1a8] hover:text-white">
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="flex items-center gap-3 rounded-[12px] border border-[#2a2b30] bg-[#0d0d0e] px-3 py-3">
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[9px] border border-[#3a3017] bg-[#1c180c] text-sun">
            <WalletIcon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="m-0 font-sans text-[13px] font-semibold text-white">
              From <span className="font-normal text-[#8d867c]">(external wallet)</span>
            </p>
            <p className="m-0 mt-0.5 flex items-center gap-2 font-mono text-[12px] text-[#f3f1ec]">
              {shortAddress(own)}
              <span className="flex items-center gap-1 font-sans text-[11.5px] text-[#2fd27a]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#2fd27a]" aria-hidden="true" />
                Connected
              </span>
            </p>
          </div>
          <button type="button" className="btn btn-ghost px-3 py-1.5 text-[12px]" onClick={() => void change()} disabled={busy}>
            Change
          </button>
        </div>

        <div className="grid gap-2">
          <p className="m-0 font-sans text-[13px] font-semibold text-white">Select token</p>
          <div className="relative">
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              disabled={busy}
              onClick={() => setMenuOpen((v) => !v)}
              className="flex h-[52px] w-full items-center gap-3 rounded-[12px] border border-sun/60 bg-[#0d0d0e] px-3 text-left"
            >
              {tokenIcon(choice)}
              <span className="flex-1 font-sans text-[15px] font-semibold text-white">{label}</span>
              <ChevronDownIcon size={16} className={`text-[#b7b1a8] transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
            </button>
            {menuOpen ? (
              <ul role="listbox" aria-label="Token to deposit" className="absolute inset-x-0 top-[58px] z-10 m-0 grid list-none gap-1 rounded-[12px] border border-[#2a2b30] bg-[#121213] p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.5)]">
                {(['ETH', ...(tusd ? (['TUSD'] as const) : [])] as Choice[]).map((c) => (
                  <li key={c} role="option" aria-selected={c === choice}>
                    <button
                      type="button"
                      onClick={() => pick(c)}
                      className={`flex w-full items-center gap-3 rounded-[9px] px-2.5 py-2 text-left hover:bg-[#1c1c1e] ${c === choice ? 'bg-[#1c180c]' : ''}`}
                    >
                      {tokenIcon(c, 26)}
                      <span className="flex-1 font-sans text-[14px] text-white">{c === 'TUSD' ? 'tUSD' : 'ETH'}</span>
                      <span className="font-sans text-[12px] text-[#8d867c]">{balanceText(c)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="m-0 font-sans text-[13px] font-semibold text-white">Amount</p>
            <span className="flex items-center gap-2 font-sans text-[12px] text-[#8d867c]">
              Balance: {balanceText(choice)}
              <button
                type="button"
                className="rounded-[6px] border border-sun/70 px-2 py-0.5 font-sans text-[11.5px] font-semibold text-sun disabled:opacity-40"
                onClick={() => setShare(100)}
                disabled={busy || !max}
              >
                Max
              </button>
            </span>
          </div>
          <div className="grid gap-3 rounded-[12px] border border-[#2a2b30] bg-[#0d0d0e] px-3.5 pb-3 pt-3">
            <div>
              <input
                className="w-full bg-transparent font-sans text-[26px] font-bold text-white outline-none placeholder:text-[#4a4a4a]"
                inputMode="decimal"
                aria-label={`Amount of ${label} to deposit`}
                placeholder="0"
                value={text}
                onChange={(e) => setText(e.target.value.trim())}
                disabled={busy}
              />
              {dollars != null && amount > 0 ? <p className="m-0 font-sans text-[12.5px] text-[#8d867c]">≈ {usd(dollars)}</p> : null}
            </div>
            {/* The same gold share slider as Swap's: the badge follows the thumb. */}
            <div className="relative mx-[8px] mt-[22px]">
              <span
                className="pointer-events-none absolute -top-[26px] rounded-[4px] bg-sun px-[6px] py-[1px] font-sans text-[10px] font-bold text-sun-ink"
                style={{ left: `${pct}%`, transform: `translateX(-${pct}%)` }}
                aria-hidden
              >
                {Math.round(pct)}%
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(pct)}
                onChange={(e) => setShare(Number(e.target.value))}
                disabled={busy || !max}
                aria-label="Share of your connected wallet's balance"
                className="h-[8px] w-full cursor-pointer appearance-none rounded-full accent-sun disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: `linear-gradient(90deg, #f7d047 ${pct}%, #262626 ${pct}%)` }}
              />
              <div className="mt-[8px] flex justify-between">
                {MARKS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setShare(m)}
                    disabled={busy || !max}
                    className={`hit-y-44 px-[2px] font-sans text-[10.5px] disabled:opacity-40 ${Math.round(pct) === m && units != null ? 'font-semibold text-sun' : 'text-[#8a8a8a]'}`}
                  >
                    {m}%
                  </button>
                ))}
              </div>
            </div>
          </div>
          {tooMuch ? <p className="m-0 font-sans text-[12px] text-[#e0b070]">That is more than this wallet can deposit.</p> : null}
        </div>

        <div className="grid gap-2 rounded-[12px] border border-[#2a2b30] bg-[#0d0d0e] px-3.5 py-3">
          <div className="flex items-center gap-3">
            {tokenIcon(choice, 38)}
            <div>
              <p className="m-0 font-sans text-[12px] text-[#8d867c]">You will deposit</p>
              <p className="m-0 font-sans text-[17px] font-bold text-white">
                {units != null ? grouped(fromUnits(units, decimals)) : '0'} {label}
              </p>
              {dollars != null && amount > 0 ? <p className="m-0 font-sans text-[12px] text-[#8d867c]">≈ {usd(dollars)}</p> : null}
            </div>
          </div>
          <div className="grid gap-1.5 border-t border-[#26262a] pt-2.5">
            <AddressLine name="From (external wallet)" address={own} />
            <AddressLine name="To (Flizy wallet)" address={flizyAddress} />
          </div>
        </div>

        <p className="m-0 font-sans text-[12px] text-[#8d867c]">You&apos;ll be asked to approve this transaction in your wallet.</p>

        <button
          type="button"
          className="btn btn-primary flex w-full items-center justify-center gap-2 py-3.5 text-[15px]"
          disabled={!canDeposit}
          onClick={() => void deposit()}
        >
          {busy ? 'Approve in your wallet' : `Deposit ${units != null && units > 0n ? `${grouped(fromUnits(units, decimals))} ` : ''}${label}`}
          {busy ? null : <ArrowRightIcon size={16} />}
        </button>

        {error ? (
          <p className="m-0 font-sans text-[12.5px] text-[#e0b070]" role="alert">
            {error}
          </p>
        ) : null}
        {done ? (
          <p className="m-0 font-sans text-[12.5px] text-[#2fd27a]" role="status">
            {done.text}{' '}
            <a href={done.url} target="_blank" rel="noreferrer noopener" className="text-sun no-underline">
              View on explorer
            </a>
          </p>
        ) : null}
        {footer}
      </div>
    </div>,
    document.body
  );
}

function AddressLine({ name, address }: { name: string; address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-2 font-sans text-[12px]">
      <span className="text-[#8d867c]">{name}</span>
      <span className="flex items-center gap-1.5 font-mono text-[#f3f1ec]">
        {shortAddress(address)}
        <button
          type="button"
          aria-label={copied ? 'Copied' : `Copy ${name}`}
          className="inline-flex text-[#8d867c] hover:text-white"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(address)
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
        >
          <CopyIcon size={13} />
        </button>
      </span>
    </div>
  );
}
