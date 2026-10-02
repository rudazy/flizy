'use client';

import { CloseIcon } from './ExploreIcons';
import { ethFromWei } from '../lib/nftFormat';

export type SalePoint = { t: string; priceWei: string };

const GOLD = '#f7d047';

function eth(wei: string): number {
  return Number(BigInt(wei)) / 1e18;
}

function path(points: SalePoint[], w: number, h: number, pad: number) {
  const ys = points.map((p) => eth(p.priceWei));
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || max || 1;
  const xy = ys.map((y, i) => [
    points.length === 1 ? w / 2 : pad + (i / (points.length - 1)) * (w - pad * 2),
    h - pad - ((y - min) / span) * (h - pad * 2),
  ]);
  return { xy, line: xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') };
}

/** Sale prices as a small gold line. Fewer than two sales: a flat dashed line. */
export function FloorSparkline({ points, width = 150, height = 34 }: { points: SalePoint[]; width?: number; height?: number }) {
  if (points.length < 2) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="shrink-0">
        <path d={`M0 ${height / 2} L${width} ${height / 2}`} stroke="#5c5c60" strokeWidth="1.2" strokeDasharray="3 3" />
      </svg>
    );
  }
  const { line } = path(points, width, height, 3);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="shrink-0">
      <path d={`${line} L${width - 3} ${height} L3 ${height} Z`} fill={GOLD} fillOpacity="0.08" />
      <path d={line} fill="none" stroke={GOLD} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** Every sale, oldest to newest, in a sheet. */
export function FloorChartSheet({ points, name, onClose }: { points: SalePoint[]; name: string; onClose: () => void }) {
  const w = 340;
  const h = 180;
  const ys = points.map((p) => p.priceWei);
  const sorted = [...ys].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  const chart = points.length ? path(points, w, h, 12) : null;
  const date = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${name} sales chart`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-t-[14px] border border-b-0 border-[#26272c] bg-[#101012] px-[18px] pb-[max(18px,env(safe-area-inset-bottom))] pt-[14px]"
      >
        <div className="mx-auto mb-[12px] h-[4px] w-[38px] rounded-full bg-[#2c2d33]" aria-hidden />
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="m-0 font-sans text-[16px] font-bold text-white">Sales</h2>
            <p className="m-0 mt-[2px] font-sans text-[12px] text-[#a9a9a9]">
              {points.length} {points.length === 1 ? 'sale' : 'sales'} on Flizy, {name}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="hit-44 flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[#1a1a1d] text-[#d9d9d9]">
            <CloseIcon size={14} />
          </button>
        </div>
        {chart ? (
          <>
            <svg viewBox={`0 0 ${w} ${h}`} className="mt-[14px] h-auto w-full" role="img" aria-label="Sale prices over time">
              {[0.25, 0.5, 0.75].map((f) => (
                <path key={f} d={`M0 ${h * f} L${w} ${h * f}`} stroke="#1f2024" strokeWidth="1" />
              ))}
              <path d={`${chart.line} L${chart.xy[chart.xy.length - 1][0]} ${h} L${chart.xy[0][0]} ${h} Z`} fill={GOLD} fillOpacity="0.08" />
              <path d={chart.line} fill="none" stroke={GOLD} strokeWidth="1.8" strokeLinejoin="round" />
              {chart.xy.map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r="2.6" fill={GOLD} />
              ))}
            </svg>
            <div className="mt-[8px] flex justify-between font-sans text-[11px] text-[#8d8d8d]">
              <span>{date(points[0].t)}</span>
              <span>{date(points[points.length - 1].t)}</span>
            </div>
            <div className="mt-[12px] grid grid-cols-3 gap-[8px] rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[12px] font-sans">
              {[
                ['Lowest', sorted[0]],
                ['Highest', sorted[sorted.length - 1]],
                ['Last', ys[ys.length - 1]],
              ].map(([label, wei]) => (
                <div key={label}>
                  <span className="block text-[10.5px] uppercase tracking-wide text-[#8d8d8d]">{label}</span>
                  <span className="block text-[13px] font-semibold text-white">{ethFromWei(wei)} ETH</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="m-0 mt-[18px] font-sans text-[12.5px] text-[#a9a9a9]">No sales yet. The chart starts with the first one.</p>
        )}
      </div>
    </div>
  );
}
