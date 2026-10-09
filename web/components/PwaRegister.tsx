'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

/** "Later" holds for this long in this browser. */
const LATER_MS = 14 * 24 * 3600 * 1000;
const LATER_KEY = 'flizy:install-later';

/** Whether "Later" was pressed recently. Storage can be off; then it simply asks again. */
function laterStillHolds(): boolean {
  try {
    const at = Number(window.localStorage.getItem(LATER_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < LATER_MS;
  } catch {
    return false;
  }
}

/**
 * Registers the service worker everywhere, and offers to install only inside
 * the signed-in app: not over sign-up, login or a pay link, and not again for
 * two weeks after "Later".
 */
export function PwaRegister() {
  const pathname = usePathname() || '';
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (window.matchMedia('(display-mode: standalone)').matches) {
      setInstalled(true);
    }
    if (laterStillHolds()) setDismissed(true);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* silent: SW optional for first paint */
      });
    }

    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };

    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBip);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }

  function later() {
    setDismissed(true);
    try {
      window.localStorage.setItem(LATER_KEY, String(Date.now()));
    } catch {
      // Storage off: it is dismissed for this visit only.
    }
  }

  if (installed || dismissed || !deferred || !pathname.startsWith('/dashboard')) return null;

  return (
    <div className="fixed inset-x-0 bottom-[calc(var(--app-nav-h)+var(--app-nav-overhang)+0.5rem)] z-[60] px-3 md:bottom-4 md:left-auto md:right-4 md:max-w-sm md:px-0">
      <div className="card flex items-center gap-3 border-lime/25 p-3 shadow-glow">
        <div className="min-w-0 flex-1">
          <p className="font-sans text-sm text-paper">Install Flizy</p>
          <p className="text-xs text-muted">Add to your home screen from Chrome.</p>
        </div>
        <button type="button" className="btn btn-primary !px-3 !py-1.5 text-xs" onClick={install}>
          Install
        </button>
        <button
          type="button"
          className="btn btn-ghost !px-2 !py-1.5 text-xs"
          onClick={later}
          aria-label="Dismiss"
        >
          Later
        </button>
      </div>
    </div>
  );
}
