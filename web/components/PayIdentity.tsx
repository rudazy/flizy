'use client';

import { useEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';
import { formatPayCode } from '../lib/dashboardTypes';

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
  qrUrl,
  username,
  displayName,
  code,
}: {
  /** Shareable /pay/{username} link. Typed and pasted by people. */
  url: string;
  /**
   * What the QR encodes: /pay/c/{code}, and nothing else. Routes on the
   * permanent code, carries no name, so printed paper survives a rename.
   */
  qrUrl: string;
  /** Offered as a copy button; deliberately NOT printed. See the sheet below. */
  username: string | null;
  /** Offered as a copy button; deliberately NOT printed. */
  displayName?: string | null;
  /**
   * Printed under the QR as the readable fallback. The QR and this code are the
   * same permanent identifier, so a scratched or badly lit QR drops the payer
   * onto the same routing key rather than onto the username, which can move and
   * can be taken by someone else.
   */
  code?: string | null;
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
        await QR.toCanvas(canvas, qrUrl, {
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
  }, [qrUrl]);

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

      {/*
        Printed sheet carries the pay code alone -- the bank-account model. You
        give out the number; the payer sees whose account it is on the confirm
        screen, read live. A name on paper is the only thing here that could go
        stale, so it is not on the paper.
      */}
      <div className="text-center">
        {code ? (
          <>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
              Pay code
            </p>
            <p className="mt-1 font-mono text-2xl tracking-[0.2em] text-paper">
              {formatPayCode(code)}
            </p>
          </>
        ) : (
          <p className="font-mono text-sm text-muted">Pay code is issued shortly.</p>
        )}
      </div>

      <div className="flex flex-wrap justify-center gap-2 print:hidden">
        {username ? <CopyButton value={`@${username}`} label="Copy @username" /> : null}
        {/* Copy gives the bare digits; the grouping is for eyes only. */}
        {code ? <CopyButton value={code} label="Copy pay code" /> : null}
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
