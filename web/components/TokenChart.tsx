'use client';

import { useEffect, useRef, useState } from 'react';
import type { Candle } from '../lib/tokenMarket';

/**
 * The price chart on a token page, drawn as SVG.
 *
 * A pool's price only changes when somebody trades, so the line is a step:
 * flat at the price the window opened at, moving at each trade, and running
 * to the right edge at the pool price now. A quiet range is a flat line, not
 * an empty box, because a flat line is what the price did.
 */

const UP = '#2fd27a';
const DOWN = '#f05252';
const GRID = '#1f1f1f';
const AXIS_TEXT = '#8f8f8f';
const RIGHT_AXIS = 64;
const BOTTOM_AXIS = 22;
const TOP_PAD = 10;
/** Share of the plot the volume bars may use, at the bottom. */
const VOLUME_SHARE = 0.18;

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Two or three significant figures, the way the price axis reads. */
export function axisPrice(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  return Number(v.toPrecision(v < 1 ? 2 : 4)).toString();
}

function clock(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function TokenChart({
  candles,
  startPriceEth,
  currentPriceEth,
  windowStart,
  windowEnd,
  mode,
  height = 300,
}: {
  candles: Candle[];
  startPriceEth: number | null;
  currentPriceEth: number | null;
  windowStart: number;
  windowEnd: number;
  mode: 'line' | 'candle';
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const start = startPriceEth ?? candles[0]?.open ?? currentPriceEth;
  const end = currentPriceEth ?? candles[candles.length - 1]?.close ?? start;

  if (start == null || end == null || windowEnd <= windowStart) {
    return (
      <div ref={ref} className="flex items-center justify-center text-sm text-muted" style={{ height }}>
        The price could not be read.
      </div>
    );
  }

  const plotW = Math.max(0, width - RIGHT_AXIS);
  const plotH = height - BOTTOM_AXIS - TOP_PAD;
  const values = [start, end, ...candles.flatMap((c) => [c.high, c.low])].filter((v) => Number.isFinite(v) && v > 0);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < max * 1e-6) {
    // A flat range: give it room so the line sits mid-chart, not on an edge.
    min *= 0.95;
    max *= 1.05;
  }
  const pad = (max - min) * 0.1;
  min = Math.max(0, min - pad);
  max += pad;
  const priceH = plotH * (1 - VOLUME_SHARE);

  const x = (t: number) => ((t - windowStart) / (windowEnd - windowStart)) * plotW;
  const y = (p: number) => TOP_PAD + (1 - (p - min) / (max - min)) * priceH;

  const up = end >= start;
  const lineColor = up ? UP : DOWN;

  // Step path: hold the last price until the next trade.
  let path = `M0 ${y(start)}`;
  for (const c of candles) {
    path += ` H${x(c.time)} V${y(c.close)}`;
  }
  path += ` H${plotW} V${y(end)}`;
  const fill = `${path} V${TOP_PAD + priceH} H0 Z`;

  const ticksY = [0, 1, 2, 3].map((i) => max - ((max - min) * i) / 3);
  const ticksX = [0, 1, 2, 3, 4, 5, 6].map((i) => windowStart + ((windowEnd - windowStart) * i) / 6);
  const maxVol = Math.max(0, ...candles.map((c) => c.volumeEth));
  const bucket = candles.length > 1 ? candles[1].time - candles[0].time : (windowEnd - windowStart) / 30;
  const barW = Math.max(2, (bucket / (windowEnd - windowStart)) * plotW * 0.7);

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label="Price chart">
          <defs>
            <linearGradient id="token-chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity="0.32" />
              <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
            </linearGradient>
          </defs>

          {ticksY.map((v, i) => (
            <g key={`y${i}`}>
              <line x1={0} x2={plotW} y1={y(v)} y2={y(v)} stroke={GRID} strokeDasharray="3 4" />
              <text x={plotW + 8} y={y(v) + 4} fill={AXIS_TEXT} fontSize="12" fontFamily="var(--font-geist-mono), monospace">
                {axisPrice(v)}
              </text>
            </g>
          ))}
          {ticksX.map((t, i) => (
            <g key={`x${i}`}>
              <line x1={x(t)} x2={x(t)} y1={TOP_PAD} y2={TOP_PAD + plotH} stroke={GRID} strokeDasharray="3 4" />
              <text
                x={Math.min(Math.max(x(t), 18), plotW - 18)}
                y={height - 5}
                fill={AXIS_TEXT}
                fontSize="12"
                textAnchor="middle"
                fontFamily="var(--font-geist-mono), monospace"
              >
                {clock(t)}
              </text>
            </g>
          ))}

          {maxVol > 0
            ? candles.map((c) => {
                const h = (c.volumeEth / maxVol) * plotH * VOLUME_SHARE;
                return (
                  <rect
                    key={`v${c.time}`}
                    x={x(c.time)}
                    y={TOP_PAD + plotH - h}
                    width={barW}
                    height={h}
                    fill={c.close >= c.open ? UP : DOWN}
                    opacity={0.28}
                  />
                );
              })
            : null}

          {mode === 'line' ? (
            <>
              <path d={fill} fill="url(#token-chart-fill)" />
              <path d={path} fill="none" stroke={lineColor} strokeWidth={2} strokeLinejoin="round" />
            </>
          ) : (
            <>
              <path d={path} fill="none" stroke={lineColor} strokeWidth={1} strokeOpacity={0.35} />
              {candles.map((c) => {
                const color = c.close >= c.open ? UP : DOWN;
                const cx = x(c.time) + barW / 2;
                const top = y(Math.max(c.open, c.close));
                const bodyH = Math.max(1.5, Math.abs(y(c.open) - y(c.close)));
                return (
                  <g key={`c${c.time}`}>
                    <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth={1.2} />
                    <rect x={cx - barW / 2} y={top} width={barW} height={bodyH} fill={color} rx={1} />
                  </g>
                );
              })}
            </>
          )}

          {/* The pool price now, tagged on the price axis. */}
          <g>
            <rect x={plotW + 2} y={y(end) - 11} width={RIGHT_AXIS - 4} height={22} rx={5} fill={lineColor} />
            <text
              x={plotW + RIGHT_AXIS / 2}
              y={y(end) + 4}
              fill="#0b0b0b"
              fontSize="12"
              fontWeight="700"
              textAnchor="middle"
              fontFamily="var(--font-geist-mono), monospace"
            >
              {axisPrice(end)}
            </text>
          </g>
        </svg>
      ) : null}
      {!candles.length ? (
        <p className="pointer-events-none absolute left-3 top-2 m-0 text-xs text-muted">
          No trades in this range. The pool price has not moved.
        </p>
      ) : null}
    </div>
  );
}
