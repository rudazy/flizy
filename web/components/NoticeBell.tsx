'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { BellIcon } from './ExploreIcons';

type Notice = {
  id: string;
  body: string;
  createdAt: string;
  unread: boolean;
};

const PANEL =
  'absolute right-0 top-[calc(100%+8px)] z-50 w-[min(22rem,calc(100vw-2rem))] rounded-[8px] border border-[#2a2b30] bg-[#101012] text-left shadow-[0_18px_50px_rgba(0,0,0,0.45)]';

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function NoticeBell({ className, iconSize = 17 }: { className: string; iconSize?: number }) {
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const unread = (notices || []).reduce((sum, row) => sum + (row.unread ? 1 : 0), 0);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/notices');
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Could not load payments.');
      const rows = Array.isArray(data?.notices) ? data.notices : [];
      setNotices(
        rows
          .filter((row: Notice) => row && typeof row.id === 'string' && typeof row.body === 'string')
          .map((row: Notice) => ({
            id: row.id,
            body: row.body,
            createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
            unread: row.unread === true,
          }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load payments.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function mark(body: { id: string } | { all: true }) {
    const res = await fetch('/api/notices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return;
    setNotices((current) =>
      (current || []).map((row) => {
        if ('all' in body || row.id === body.id) return { ...row, unread: false };
        return row;
      })
    );
  }

  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={`${className} relative`}
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
      >
        <BellIcon size={iconSize} />
        {unread > 0 ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-sun" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div id={panelId} role="dialog" aria-label="Payments" className={PANEL}>
          <div className="flex items-center justify-between gap-3 border-b border-[#2a2b30] px-3 py-2">
            <p className="m-0 font-sans text-[13px] font-semibold text-[#f5f5f5]">Payments</p>
            {unread > 0 ? (
              <button
                type="button"
                className="min-h-11 px-1 font-sans text-[12px] text-[#f7d047]"
                onClick={() => void mark({ all: true })}
              >
                Mark all read
              </button>
            ) : (
              <button type="button" className="min-h-11 px-1 font-sans text-[12px] text-[#9d9d9d]" onClick={() => setOpen(false)}>
                Close
              </button>
            )}
          </div>
          <div className="max-h-[22rem] overflow-y-auto">
            {loading && !notices ? <p className="m-0 px-3 py-4 font-sans text-[13px] text-[#9d9d9d]">Loading payments.</p> : null}
            {error ? <p className="m-0 px-3 py-4 font-sans text-[13px] text-[#e0b070]">{error}</p> : null}
            {notices && notices.length === 0 ? (
              <p className="m-0 px-3 py-4 font-sans text-[13px] text-[#9d9d9d]">No payments yet.</p>
            ) : null}
            {notices?.map((row) => (
              <button
                key={row.id}
                type="button"
                className="flex min-h-11 w-full flex-col items-start gap-1 border-b border-[#2a2b30] px-3 py-3 text-left last:border-b-0 hover:bg-[#161616]"
                onClick={() => {
                  if (row.unread) void mark({ id: row.id });
                }}
              >
                <span className="flex w-full items-start gap-2">
                  {row.unread ? <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sun" aria-hidden="true" /> : null}
                  <span className="whitespace-pre-wrap font-sans text-[13px] leading-5 text-[#f5f5f5]">{row.body}</span>
                </span>
                {row.createdAt ? <span className="font-sans text-[11px] text-[#9d9d9d]">{ago(row.createdAt)}</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
