'use client';

import { useEffect, useId, useState } from 'react';
import { promptPwaInstall, usePwaInstall } from './pwaInstall';

const FALLBACK =
  'Use the install icon in the address bar, or the browser menu, and choose Install Flizy.';
const IOS_FALLBACK = 'In Safari, tap Share, then Add to Home Screen.';

function fallbackCopy(): string {
  if (typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
    return IOS_FALLBACK;
  }
  return FALLBACK;
}

/**
 * Opens the browser's install dialog. Shown on the opening page. Hidden once
 * Flizy is already installed. When the browser has not offered a dialog, the
 * click tells the reader where that control is.
 */
export function InstallAppButton() {
  const { installed, canPrompt } = usePwaInstall();
  const [note, setNote] = useState('');
  const noteId = useId();

  useEffect(() => {
    if (canPrompt) setNote('');
  }, [canPrompt]);

  if (installed) return null;

  async function onClick() {
    const outcome = await promptPwaInstall();
    setNote(outcome === 'unavailable' ? fallbackCopy() : '');
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost install-app-btn min-h-[44px]"
        onClick={() => void onClick()}
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
