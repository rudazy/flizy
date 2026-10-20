'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { promptPwaInstall, usePwaInstall } from './pwaInstall';

const ADDRESS_BAR =
  'Use the install icon in the address bar, or the browser menu, and choose Install Flizy.';
const IOS_FALLBACK = 'In Safari, tap Share, then Add to Home Screen.';
const RETRY = 'Click Install again.';

/** Where this browser lists installed apps. Empty when that page is not known. */
function installedAppsPage(): string {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge://apps';
  if (/OPR\//.test(ua)) return '';
  if (/Chrome\//.test(ua)) return 'chrome://apps';
  return '';
}

function fallbackCopy(): string {
  if (typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
    return IOS_FALLBACK;
  }
  const apps = installedAppsPage();
  if (!apps) return ADDRESS_BAR;
  return `${ADDRESS_BAR} If Flizy is still listed at ${apps}, remove it there and reload.`;
}

/**
 * Opens the browser's install dialog. Shown on the opening page. Hidden once
 * Flizy is already installed. When the browser has not offered a dialog, the
 * click tells the reader where that control is.
 */
export function InstallAppButton() {
  const { installed, canPrompt } = usePwaInstall();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const noteId = useId();
  const failedAttempts = useRef(0);

  useEffect(() => {
    if (!canPrompt) return;
    setNote((current) => (current === RETRY ? current : ''));
  }, [canPrompt]);

  useEffect(() => {
    const onFailed = () => {
      failedAttempts.current += 1;
      setNote(fallbackCopy());
    };
    window.addEventListener('flizy-install-failed', onFailed);
    return () => window.removeEventListener('flizy-install-failed', onFailed);
  }, []);

  if (installed) return null;

  async function onClick() {
    setBusy(true);
    const seenFailures = failedAttempts.current;
    try {
      const outcome = await promptPwaInstall();
      if (failedAttempts.current !== seenFailures) return;
      if (outcome === 'unavailable') setNote(fallbackCopy());
      else if (outcome === 'retry') setNote(RETRY);
      else setNote('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost install-app-btn min-h-[44px]"
        onClick={() => void onClick()}
        disabled={busy}
        aria-label="Install Flizy"
        aria-describedby={note ? noteId : undefined}
      >
        Install
      </button>
      {note ? (
        <p id={noteId} className="install-app-note basis-full text-xs leading-relaxed text-muted" role="status">
          {note}
        </p>
      ) : null}
    </>
  );
}
