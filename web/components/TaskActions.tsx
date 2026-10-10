'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookmarkIcon, CheckIcon, ShareIcon, StarIcon } from './ExploreIcons';

/**
 * The small actions a task carries on its card and its page: share, save, and
 * for a Flizy admin, feature. Each talks to its own route and keeps its own
 * state, so a card can hold them without the list re-rendering.
 */

type Size = 'sm' | 'md';

const SIZES: Record<Size, { box: string; icon: number }> = {
  sm: { box: 'h-[26px] w-[26px] rounded-[6px]', icon: 13 },
  md: { box: 'h-[40px] w-[40px] rounded-[8px]', icon: 17 },
};

const BUTTON = 'hit-44 relative inline-flex shrink-0 items-center justify-center border transition-colors';
const IDLE = 'border-chrome-line bg-[#111113] text-[#cfcfcf] hover:border-[#3a3b42] hover:text-white';
const ON = 'border-sun/60 bg-sun-wash text-sun';

/**
 * Share a task: the share sheet on a touch device, else copy the link. Desktop
 * browsers also expose navigator.share, but there it opens the operating
 * system's dialog, which is not what a Share icon is expected to do, and it can
 * fail with no target; copying is the predictable answer. A failed share sheet
 * falls back to copying too. The link is built from the page's own origin, so a
 * preview deploy shares its own address and never production's.
 */
export function ShareTaskButton({ taskRef, title, size = 'sm' }: { taskRef: number; title: string; size?: Size }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function share() {
    const url = `${window.location.origin}/tasks/${taskRef}`;
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (touch && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch (err) {
        // Dismissing the sheet is a choice, not a failure.
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // No clipboard permission: the button stays as it was rather than claiming a copy.
    }
  }

  const s = SIZES[size];
  return (
    <button
      type="button"
      onClick={share}
      aria-label={copied ? 'Link copied' : 'Share task'}
      title={copied ? 'Link copied' : 'Share'}
      className={`${BUTTON} ${s.box} ${copied ? ON : IDLE}`}
    >
      {copied ? <CheckIcon size={s.icon} /> : <ShareIcon size={s.icon} />}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Link copied' : ''}
      </span>
    </button>
  );
}

/**
 * Save a task to My tasks. Optimistic, and put back if the route refuses. A
 * signed-out reader is sent to log in and brought back to the same task.
 */
export function SaveTaskButton({
  taskRef,
  initialSaved,
  signedIn = true,
  size = 'sm',
}: {
  taskRef: number;
  initialSaved: boolean;
  signedIn?: boolean;
  size?: Size;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initialSaved);
  const [busy, setBusy] = useState(false);

  useEffect(() => setSaved(initialSaved), [initialSaved]);

  async function toggle() {
    if (busy) return;
    if (!signedIn) {
      router.push(`/login?next=${encodeURIComponent(`/tasks/${taskRef}`)}`);
      return;
    }
    const next = !saved;
    setSaved(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${taskRef}/save`, { method: next ? 'POST' : 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body?.saved !== 'boolean') throw new Error('refused');
      setSaved(body.saved);
    } catch {
      setSaved(!next);
    } finally {
      setBusy(false);
    }
  }

  const s = SIZES[size];
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={saved}
      aria-label={saved ? 'Remove from saved tasks' : 'Save task'}
      title={saved ? 'Saved' : 'Save'}
      className={`${BUTTON} ${s.box} ${saved ? ON : IDLE} disabled:cursor-wait`}
    >
      <BookmarkIcon size={s.icon} filled={saved} />
    </button>
  );
}

/**
 * Feature or unfeature a task. Rendered only for a Flizy admin, and the route
 * checks the flag again, so showing it to anyone else would do nothing.
 */
export function FeatureTaskButton({ taskRef, initialFeatured }: { taskRef: number; initialFeatured: boolean }) {
  const router = useRouter();
  const [featured, setFeatured] = useState(initialFeatured);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/tasks/${taskRef}/feature`, { method: featured ? 'DELETE' : 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body?.featured !== 'boolean') {
        setError(body?.error || 'Could not change that.');
        return;
      }
      setFeatured(body.featured);
      router.refresh();
    } catch {
      setError('Could not change that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={featured}
        className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[8px] border px-4 font-sans text-sm font-medium transition-colors disabled:opacity-60 ${
          featured ? ON : IDLE
        }`}
      >
        <StarIcon size={15} />
        {featured ? 'Featured. Remove from Featured' : 'Feature on Explore'}
      </button>
      {error ? <p className="m-0 text-xs text-[#f08a7a]">{error}</p> : null}
    </div>
  );
}
