'use client';

import { useEffect, useState } from 'react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export function PwaRegister() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (window.matchMedia('(display-mode: standalone)').matches) {
      setInstalled(true);
    }

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

  if (installed || dismissed || !deferred) return null;

  return (
    <div className="fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-[60] px-3 md:bottom-4 md:left-auto md:right-4 md:max-w-sm md:px-0">
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
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
        >
          Later
        </button>
      </div>
    </div>
  );
}
