'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useDashboard } from './DashboardProvider';
import { useComingSoon } from './ComingSoon';
import { useTapGesture } from './AppSection';
import { isHeld } from '../lib/dashboardTypes';
import { VerifiedMark } from './VerifiedMark';
import { AppCard as Card, AppCardHeader as CardHeader } from './AppCard';
import { WalletNfts } from './WalletNfts';
import { WalletOffers } from './WalletOffers';
import { AddTokenSheet } from './AddTokenSheet';
import { EyeMark } from './BalanceEye';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  EthDiamondIcon,
  ExternalLinkIcon,
  GiwaMarkIcon,
  InfoIcon,
  PlusIcon,
  TokensIcon,
} from './ExploreIcons';

/**
 * Wallet, Balances: the total, the address, then what the wallet holds.
 *
 * Every figure here is read from the chain or from the FLZ pool. There is no
 * dollar price for GIWA Sepolia, so values are given in ETH where a pool price
 * exists and left out where none does, rather than shown as an invented number.
 */

type Market = { priceEth: number; change1hPct: number | null };

const HIDDEN = '\u2022\u2022\u2022\u2022';

function tokenHref(token: { symbol: string; address: string | null; verified?: boolean }): string | null {
  if (token.verified && token.symbol.toUpperCase() === 'FLZ') return '/dashboard/explore/tokens/flz';
  if (token.address) return `/dashboard/explore/tokens/${token.address}`;
  return null;
}

/** Up to six decimals, trailing zeros kept, as the native balance has always been shown. */
function formatAmount(value: string | number, digits = 6): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : String(value);
}

/** A small ETH figure without a wall of zeros: 0.0123, 1.2346, 0.000041. */
function formatEth(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1) return value.toFixed(4);
  return value.toPrecision(2);
}

export function WalletBalances() {
  const { data, holdings, explorerBase, refreshAll } = useDashboard();
  const [comingSoon, comingSoonNote] = useComingSoon();
  const [hidden, setHidden] = useState(false);
  const [market, setMarket] = useState<Market | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [tokenNote, setTokenNote] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [addingToken, setAddingToken] = useState(false);

  // The FLZ pool price, for the ETH value beside an FLZ balance. A failure
  // only means that line is left out; the balance itself does not depend on it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/tokens');
        if (!res.ok) return;
        const body = await res.json();
        const flz = (body?.tokens || []).find((t: { symbol?: string }) => t.symbol === 'FLZ');
        const priceEth = Number(flz?.priceEth);
        if (!cancelled && Number.isFinite(priceEth) && priceEth > 0) {
          setMarket({
            priceEth,
            change1hPct: typeof flz.change1hPct === 'number' && Number.isFinite(flz.change1hPct) ? flz.change1hPct : null,
          });
        }
      } catch {
        /* no price line, nothing else changes */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    []
  );

  // One tap copies the address; a second tap inside the window opens it on the
  // explorer. The copy runs inside the tap, see useTapGesture.
  const onAddressTap = useTapGesture(
    () => void copyAddress(),
    () => openExplorer()
  );

  if (!data) return null;

  const address = data.account.agent_wallet_address || '';
  const native = holdings?.holdings?.native || null;
  const chainName = holdings?.holdings?.chain?.name || 'GIWA Sepolia';
  const credit = Number(data.account.balance_eth || 0);
  // Only what the wallet actually holds. The API returns every tracked token at
  // zero so other callers can read the balance; this list shows a row only when
  // there is something in it. See isHeld: an unreadable
  // row stays visible rather than being reported as none.
  const tokens = (holdings?.holdings?.tokens || []).filter((t) => isHeld(t.balance));

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  function openExplorer() {
    if (address) window.open(`${explorerBase}/address/${address}`, '_blank', 'noopener,noreferrer');
  }

  async function removeToken(tokenAddress: string) {
    if (tokenBusy) return;
    setTokenBusy(true);
    setTokenError('');
    setTokenNote('');
    try {
      const res = await fetch('/api/wallet/tokens', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: tokenAddress }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTokenError(body.error || 'Could not remove that token.');
        return;
      }
      setTokenNote('Token removed.');
      await refreshAll();
    } catch {
      setTokenError('Could not remove that token.');
    } finally {
      setTokenBusy(false);
    }
  }

  return (
    <div className="grid gap-[12.5px]">
      {/* Total balance */}
      <section
        className="relative h-[118.7px] overflow-hidden rounded-[6px] border border-[#4a3d1c]"
        style={{ background: 'linear-gradient(100deg, #0e0d0b 0%, #14120c 55%, #1c1709 100%)' }}
      >
        <HeroGlow />
        <div className="relative px-[16.5px] pt-[16.5px]">
          <div className="flex items-center gap-[10px]">
            <span className="font-mono text-[9.4px] uppercase tracking-[0.12em] text-[#cfcfcf]">Total balance</span>
            <button
              type="button"
              onClick={() => setHidden((h) => !h)}
              aria-pressed={hidden}
              aria-label={hidden ? 'Show balances' : 'Hide balances'}
              className="hit-44 flex h-[14px] w-[16px] items-center justify-center text-[#ececec] hover:text-white"
            >
              <EyeMark hidden={hidden} className="h-[15px] w-[15px]" />
            </button>
          </div>
          <div className="mt-[7px] flex items-center gap-[13px]">
            <span className="font-sans text-[28.5px] font-semibold leading-[34px] tracking-[-0.01em] text-white">
              {hidden ? HIDDEN : native ? formatAmount(native.balance) : '0.000000'}
            </span>
            <button
              type="button"
              onClick={() => comingSoon('Other assets')}
              aria-label="Show the total in another asset, coming soon"
              className="flex items-center gap-[8px] text-[#ececec] hover:text-white"
            >
              <EthDiamondIcon size={14} className="text-[#8c8fe8]" />
              <span className="font-mono text-[12.5px] tracking-[0.04em]">{native?.symbol || 'ETH'}</span>
              <ChevronDownIcon size={11} className="text-[#d9d9d9]" />
            </button>
          </div>
          <p className="m-0 mt-[9px] font-sans text-[9px] text-[#a9a9a9]">
            {credit > 0 ? (
              <>Credit {hidden ? HIDDEN : `${credit} ETH`} on {chainName}</>
            ) : (
              <>Testnet ETH on {chainName}. No dollar price.</>
            )}
          </p>
        </div>
        <div className="absolute right-[17px] top-[26px] flex w-[66px] flex-col items-center text-white">
          <GiwaMarkIcon size={26} />
          <span className="mt-[5px] whitespace-nowrap font-mono text-[9.3px] tracking-[0.1em]">GIWA CHAIN</span>
          <span className="mt-[6px] rounded-full bg-[#2a2924]/90 px-[8px] py-[2px] font-sans text-[8.6px] text-[#ececec]">
            Sepolia
          </span>
        </div>
      </section>

      {/* Address */}
      <Card className="px-[13.5px] pb-[9.5px] pt-[14px]">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-[8px] font-mono text-[8.8px] uppercase tracking-[0.1em] text-[#d6d6d6]">
            Flizy wallet address
            <CopyIcon size={11} className="text-[#cfcfcf]" />
          </span>
          <span className="flex items-center gap-[7px] font-sans text-[6.8px] text-[#a9a9a9]">
            Tap to copy {'\u00b7'} Double tap to open
            <InfoIcon size={11} className="text-[#cfcfcf]" />
          </span>
        </div>
        <button
          type="button"
          onClick={onAddressTap}
          disabled={!address}
          aria-label="Wallet address. Tap to copy it. Double tap opens it on the explorer."
          className="mt-[9px] flex h-[33.5px] w-full items-center justify-between gap-2 rounded-[4px] border border-[#2a2b30] bg-[#0b0b0c] pl-[11px] pr-[11px] text-left"
        >
          <span className="min-w-0 truncate font-sans text-[10.6px] text-[#e6e6e6]">
            {copied ? 'Copied' : address || 'Generating...'}
          </span>
          <CopyIcon size={13} className="shrink-0 text-[#d9d9d9]" />
        </button>
        <div className="mt-[10.5px] grid grid-cols-2 gap-[9.5px]">
          <button
            type="button"
            onClick={() => void copyAddress()}
            disabled={!address}
            className="hit-y-44 flex h-[31.5px] items-center justify-center gap-[12px] rounded-[4px] border border-[#2a2b30] bg-[#0f0f10] font-sans text-[10px] font-semibold text-[#ececec] hover:text-white"
          >
            <CopyIcon size={13} />
            {copied ? 'Copied' : 'Copy address'}
          </button>
          <a
            href={address ? `${explorerBase}/address/${address}` : undefined}
            target="_blank"
            rel="noreferrer"
            className="hit-y-44 flex h-[31.5px] items-center justify-center gap-[12px] rounded-[4px] border border-[#2a2b30] bg-[#0f0f10] font-sans text-[10px] font-semibold text-[#ececec] no-underline hover:text-white"
          >
            <ExternalLinkIcon size={13} />
            View on explorer
          </a>
        </div>
      </Card>

      {/* Tokens */}
      <Card className="px-[9.8px] pb-[8.5px] pt-[10.5px]">
        <CardHeader
          icon={<TokensIcon size={15} />}
          title="Tokens"
          subtitle={`Tokens in your Flizy wallet on ${chainName}.`}
          action={
            <button
              type="button"
              onClick={() => {
                if (addingToken) setAddingToken(false);
                else setSheetOpen(true);
              }}
              aria-haspopup={addingToken ? undefined : 'dialog'}
              className="hit-y-44 flex h-[26px] items-center gap-[10px] rounded-[4px] border border-sun bg-[#14120a] px-[10.5px] font-sans text-[9.6px] font-semibold text-sun"
            >
              <PlusIcon size={11} strokeWidth={2} />
              {addingToken ? 'Done' : 'Add token'}
            </button>
          }
        />

        {tokenError ? <p className="alert alert-error mt-[8px]">{tokenError}</p> : null}
        {tokenNote ? <p className="m-0 mt-[8px] font-sans text-[8.5px] text-[#a9a9a9]">{tokenNote}</p> : null}

        <ul className="m-0 mt-[12.5px] grid list-none gap-[5px] p-0">
          {native ? (
            <AssetRow
              href={address ? `${explorerBase}/address/${address}` : null}
              external
              logo={
                <span className="flex h-[37px] w-[37px] items-center justify-center rounded-full bg-[#627eea] text-white">
                  <EthDiamondIcon size={22} />
                </span>
              }
              symbol={native.symbol}
              tag={<span className="rounded-[5px] bg-[#26272b] px-[6px] py-[2px] font-sans text-[8.6px] text-[#e0e0e0]">Native</span>}
              name="Ethereum"
              amount={hidden ? HIDDEN : formatAmount(native.balance)}
            />
          ) : null}
          {tokens.map((t) => {
            const isFlz = t.verified && t.symbol.toUpperCase() === 'FLZ';
            const balance = t.balance == null ? null : Number(t.balance);
            const value = isFlz && market && balance != null ? balance * market.priceEth : null;
            return (
              <AssetRow
                key={t.address || t.symbol}
                href={addingToken ? null : tokenHref(t)}
                logo={
                  <span className="flex h-[37px] w-[37px] items-center justify-center rounded-full border-[1.5px] border-[#5a5a5a] bg-[#0a0a0a] font-sans text-[19px] font-bold text-sun">
                    {t.symbol.slice(0, 1).toUpperCase()}
                  </span>
                }
                symbol={t.symbol}
                tag={t.verified ? <VerifiedMark /> : null}
                name={isFlz ? 'Flizy' : t.address ? `${t.address.slice(0, 6)}...${t.address.slice(-4)}` : ''}
                amount={hidden ? HIDDEN : t.balance == null ? t.error || 'n/a' : formatAmount(t.balance, 3)}
                value={value != null && !hidden ? `\u2248 ${formatEth(value)} ETH` : null}
                change={isFlz && !hidden ? market?.change1hPct ?? null : null}
                extra={
                  addingToken && t.added && t.address ? (
                    <button
                      type="button"
                      className="hit-y-44 font-sans text-[8.5px] text-[#a9a9a9] hover:text-white"
                      disabled={tokenBusy}
                      onClick={() => removeToken(t.address as string)}
                    >
                      Remove
                    </button>
                  ) : null
                }
              />
            );
          })}
          {!native && !tokens.length ? (
            <li className="rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] px-[10px] py-[12px] font-sans text-[9px] text-[#a9a9a9]">
              {holdings?.holdings?.note || 'Tokens appear here once you hold some.'}
            </li>
          ) : null}
        </ul>
      </Card>

      {/* NFTs: every collection the wallet holds, from the explorer. */}
      <WalletNfts chainName={chainName} hidden={hidden} />
      <WalletOffers hidden={hidden} />
      <AddTokenSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onAdded={(message) => {
          setSheetOpen(false);
          setTokenError('');
          setTokenNote(message);
          void refreshAll();
        }}
        onManage={
          tokens.some((t) => t.added)
            ? () => {
                setSheetOpen(false);
                setAddingToken(true);
              }
            : null
        }
      />
      {comingSoonNote}
    </div>
  );
}

/** The lit edge of a planet on the right of the total, drawn with two gradients. */
function HeroGlow() {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0">
      <span
        className="absolute rounded-full"
        style={{
          left: '254px',
          top: '-26px',
          width: '176px',
          height: '176px',
          background: 'radial-gradient(circle at 60% 45%, #15130d 0%, #100e09 70%)',
          // Lit from the lower left: a thin bright rim, then a warm haze inside it.
          boxShadow:
            'inset 1.5px -1px 0 0 rgba(255, 214, 92, 0.85), inset 6px -4px 14px -3px rgba(247, 190, 60, 0.5), inset 26px -14px 40px -10px rgba(247, 180, 50, 0.18), -3px 2px 16px 0 rgba(247, 190, 60, 0.35)',
        }}
      />
    </span>
  );
}

function AssetRow({
  href,
  external = false,
  logo,
  symbol,
  tag,
  name,
  amount,
  value = null,
  change = null,
  extra = null,
}: {
  href: string | null;
  external?: boolean;
  logo: ReactNode;
  symbol: string;
  tag: ReactNode;
  name: string;
  amount: string;
  value?: string | null;
  change?: number | null;
  extra?: ReactNode;
}) {
  const body = (
    <>
      <span className="shrink-0">{logo}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-[7px]">
          <span className="font-sans text-[11.8px] font-medium text-white">{symbol}</span>
          {tag}
        </span>
        <span className="mt-[2px] block truncate font-sans text-[9.3px] text-[#a9a9a9]">{name}</span>
      </span>
      <span className="grid shrink-0 justify-items-start">
        <span className="font-sans text-[11.5px] font-semibold text-white">{amount}</span>
        {value ? <span className="font-sans text-[8.6px] text-[#b5b5b5]">{value}</span> : null}
        {change != null ? (
          <span className={`font-sans text-[8px] ${change >= 0 ? 'text-[#2fd27a]' : 'text-[#f05252]'}`}>
            {change >= 0 ? '\u25b2' : '\u25bc'} {change >= 0 ? '+' : ''}
            {change.toFixed(1)}% (1h)
          </span>
        ) : null}
        {extra}
      </span>
      <ChevronRightIcon size={13} className="ml-[18px] shrink-0 text-[#cfcfcf]" />
    </>
  );
  const className =
    'flex min-h-[57px] items-center gap-[12px] rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] py-[8px] pl-[7.5px] pr-[12px] no-underline';
  return (
    <li>
      {href ? (
        external ? (
          <a href={href} target="_blank" rel="noreferrer" className={className}>
            {body}
          </a>
        ) : (
          <Link href={href} className={className}>
            {body}
          </Link>
        )
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  );
}
