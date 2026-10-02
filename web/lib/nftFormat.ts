/**
 * Display helpers for NFT pages: wei as ETH, the USD reference line, short
 * addresses and relative times. Pure, so both the pages and node tests use it.
 */

import { formatEther } from 'ethers';
import { formatEthDisplay } from './tokenFormat.ts';

/** "0.098" for wei, or null. Never a dollar sign: USD is usdLabel's job. */
export function ethFromWei(wei: string | bigint | null | undefined): string | null {
  if (wei == null || wei === '') return null;
  try {
    return formatEthDisplay(formatEther(BigInt(wei)), 4);
  } catch {
    return null;
  }
}

/** "≈ $240.12" for an amount in wei at the mainnet rate, or null when there is no rate. */
export function usdLabel(wei: string | bigint | null | undefined, usdPerEth: number | null): string | null {
  if (wei == null || wei === '' || usdPerEth == null) return null;
  let value: bigint;
  try {
    value = BigInt(wei);
  } catch {
    return null;
  }
  // Cents in integers: wei * (usd * 100) / 1e18.
  const cents = (value * BigInt(Math.round(usdPerEth * 100))) / 10n ** 18n;
  const dollars = Number(cents) / 100;
  if (!Number.isFinite(dollars)) return null;
  if (dollars >= 1000) {
    return `≈ $${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(dollars)}`;
  }
  return `≈ $${dollars.toFixed(2)}`;
}

export function shortAddr(address: string | null | undefined): string {
  if (!address) return '-';
  return address.length < 12 ? address : `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** "3m ago", "5h ago", "2d ago", or the date past a month. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Sep 2026" for the created chip. */
export function monthYear(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "10K", "2,415" style counts. */
export function compactCount(n: number | string | null | undefined): string {
  if (n == null || n === '') return '-';
  const value = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(value)) return '-';
  if (value >= 10_000) return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  return value.toLocaleString('en-US');
}

/** Percent of a royalty in basis points: 500 -> "5%", 250 -> "2.5%". */
export function bpsLabel(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}
