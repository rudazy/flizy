'use client';

import { useEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('logo'));
    img.src = src;
  });
}

function drawCenterMark(canvas: HTMLCanvasElement, logo: HTMLImageElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = canvas.width;
  const mark = Math.round(size * 0.2);
  const pad = 7;
  const x = (size - mark) / 2;
  const y = (size - mark) / 2;
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(x - pad, y - pad, mark + pad * 2, mark + pad * 2);
  ctx.drawImage(logo, x, y, mark, mark);
}

export function PayIdentity({
  url,
  username,
  displayName,
}: {
  url: string;
  username: string | null;
  displayName?: string | null;
  code?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [qrReady, setQrReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const QR = await import('qrcode');
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        await QR.toCanvas(canvas, url, {
          width: 280,
          margin: 2,
          errorCorrectionLevel: 'H',
          color: { dark: '#0a0a0a', light: '#f5f5f5' },
        });
        let logo: HTMLImageElement;
        try {
          logo = await loadImage('/favicon.svg');
        } catch {
          logo = await loadImage('/icon-192.png');
        }
        if (cancelled || !canvasRef.current) return;
        drawCenterMark(canvas, logo);
        setQrReady(true);
      } catch {
        if (!cancelled) setQrReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  function onPrint() {
    window.print();
  }

  function onDownload() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `flizy-pay-${username || 'me'}.png`;
    a.click();
  }

  return (
    <div className="pay-print space-y-5">
      <div className="flex flex-col items-center gap-3">
        <canvas
          ref={canvasRef}
          width={280}
          height={280}
          className="border border-border bg-paper"
          aria-label="Pay QR"
        />
        {!qrReady ? <p className="text-xs text-muted">Preparing QR…</p> : null}
      </div>

      <div className="text-center">
        {displayName ? (
          <p className="font-sans text-xl tracking-wide text-paper">{displayName}</p>
        ) : null}
        {username ? (
          <p className={`font-mono text-lg text-paper ${displayName ? 'mt-1' : ''}`}>
            @{username}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap justify-center gap-2 print:hidden">
        {username ? <CopyButton value={`@${username}`} label="Copy @username" /> : null}
        <CopyButton value={url} label="Copy link" />
        <button type="button" className="btn btn-ghost text-sm" onClick={onDownload} disabled={!qrReady}>
          Download QR
        </button>
        <button type="button" className="btn btn-primary text-sm" onClick={onPrint}>
          Print
        </button>
      </div>
    </div>
  );
}
