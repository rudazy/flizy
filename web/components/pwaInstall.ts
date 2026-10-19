'use client';

import { useSyncExternalStore } from 'react';

/**
 * One captured browser install prompt for the whole tab. Chromium fires
 * beforeinstallprompt at most once per page load. The opening page and the
 * dashboard banner both read that single event from here.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type PwaInstallSnapshot = {
  installed: boolean;
  canPrompt: boolean;
};

const SERVER_SNAPSHOT: PwaInstallSnapshot = { installed: false, canPrompt: false };

let snapshot: PwaInstallSnapshot = SERVER_SNAPSHOT;
let deferred: BeforeInstallPromptEvent | null = null;
let prompting = false;
let listening = false;
const listeners = new Set<() => void>();

function emit(next: PwaInstallSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function publish() {
  emit({
    installed: snapshot.installed,
    canPrompt: deferred !== null && !snapshot.installed,
  });
}

function alreadyStandalone(): boolean {
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

/** Start listening. Safe to call more than once, and only in the browser. */
function startPwaInstallCapture() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  if (alreadyStandalone()) {
    snapshot = { installed: true, canPrompt: false };
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    publish();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit({ installed: true, canPrompt: false });
  });
}

function subscribePwaInstall(listener: () => void) {
  startPwaInstallCapture();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getPwaInstallSnapshot(): PwaInstallSnapshot {
  return snapshot;
}

function getPwaInstallServerSnapshot(): PwaInstallSnapshot {
  return SERVER_SNAPSHOT;
}

export function usePwaInstall(): PwaInstallSnapshot {
  return useSyncExternalStore(subscribePwaInstall, getPwaInstallSnapshot, getPwaInstallServerSnapshot);
}

/**
 * Open the browser install dialog. Call this from a click.
 * "unavailable" means this browser has not offered a dialog yet.
 */
export async function promptPwaInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  startPwaInstallCapture();
  const pending = deferred;
  if (prompting) return 'dismissed';
  if (!pending) return 'unavailable';
  // Call prompt() before notifying subscribers. A re-render in this turn
  // must not land before prompt() runs.
  prompting = true;
  deferred = null;
  try {
    const opened = pending.prompt();
    publish();
    await opened;
    const choice = await pending.userChoice;
    if (choice.outcome === 'accepted') {
      emit({ installed: true, canPrompt: false });
    }
    return choice.outcome;
  } catch {
    publish();
    return 'unavailable';
  } finally {
    prompting = false;
  }
}
