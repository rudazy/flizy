'use client';

import { useSyncExternalStore } from 'react';

/**
 * One captured browser install prompt for the whole tab. Chromium fires
 * beforeinstallprompt at most once per page load. The inline script in the
 * root layout stores that event before hydration. The opening page and the
 * dashboard banner both read it from here.
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

type InstallWindow = Window & {
  __flizyInstallPrompt?: BeforeInstallPromptEvent | null;
  __flizyInstallBound?: boolean;
};

function installWindow(): InstallWindow | null {
  if (typeof window === 'undefined') return null;
  return window as InstallWindow;
}

function stashedEvent(): BeforeInstallPromptEvent | null {
  return installWindow()?.__flizyInstallPrompt || null;
}

function clearStash() {
  const host = installWindow();
  if (host) host.__flizyInstallPrompt = null;
}

/** Take the prompt the early script stored, if this tab has not taken it yet. */
function adopt() {
  const pending = stashedEvent();
  if (!pending || pending === deferred) return;
  deferred = pending;
  publish();
}

function onInstalled() {
  deferred = null;
  clearStash();
  emit({ installed: true, canPrompt: false });
}

/** Start listening. Safe to call more than once, and only in the browser. */
function startPwaInstallCapture() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  if (alreadyStandalone()) {
    snapshot = { installed: true, canPrompt: false };
  }

  const host = installWindow();
  if (host?.__flizyInstallBound) {
    adopt();
    window.addEventListener('flizy-install-ready', adopt);
    window.addEventListener('flizy-install-done', onInstalled);
    return;
  }

  // The early script did not run. Listen here so Install still has a prompt.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    if (host) host.__flizyInstallPrompt = event as BeforeInstallPromptEvent;
    adopt();
    window.dispatchEvent(new Event('flizy-install-ready'));
  });
  window.addEventListener('appinstalled', onInstalled);
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
 * After a cleared visit Chrome often withholds its one install prompt until
 * the service worker is active, a few seconds after load. The wait only
 * listens. prompt() stays on a later click, because a click's gesture does
 * not survive the wait.
 */
const PROMPT_WAIT_MS = 4000;

function iosDevice(): boolean {
  return typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function waitForInstallEvent(ms: number): Promise<void> {
  if (deferred || stashedEvent()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      window.removeEventListener('flizy-install-ready', finish);
      resolve();
    };
    const timer = window.setTimeout(finish, ms);
    window.addEventListener('flizy-install-ready', finish);
  });
}

/**
 * prompt() consumes the event. The reader's choice settles later. The click
 * must return without waiting for it, or Install stays disabled for as long
 * as that choice is pending. Later clicks stay quiet until the choice
 * arrives or the open itself fails.
 */
function settleChoice(pending: BeforeInstallPromptEvent, opened: Promise<void>) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    prompting = false;
  };
  void opened.catch(() => {
    // The click may already have returned. Tell the button the dialog did not open.
    window.dispatchEvent(new Event('flizy-install-failed'));
    publish();
    release();
  });
  void pending.userChoice.then(
    (choice) => {
      if (choice.outcome === 'accepted') {
        emit({ installed: true, canPrompt: false });
      }
      release();
    },
    () => {
      publish();
      release();
    },
  );
}

/**
 * Open the browser install dialog. Call this from a click.
 * When a dialog was already offered, prompt() runs in this click and the
 * choice is applied when the dialog closes.
 * "unavailable" means this browser has not offered a dialog.
 * "retry" means a dialog is offered, but this click could not open it.
 * "opened" means the dialog was asked to open.
 * "dismissed" means a dialog is already in progress.
 */
export async function promptPwaInstall(): Promise<'dismissed' | 'unavailable' | 'retry' | 'opened'> {
  if (prompting) return 'dismissed';
  prompting = true;
  let tracking = false;
  try {
    startPwaInstallCapture();
    adopt();
    // prompt() has to run before any await, or this click's gesture is gone
    // and Chrome will not open the dialog. A prompt that arrives during the
    // wait is kept for the next click.
    const hadPrompt = Boolean(deferred);
    if (!hadPrompt && !iosDevice()) {
      await waitForInstallEvent(PROMPT_WAIT_MS);
      adopt();
    }
    const pending = deferred;
    if (!pending) return 'unavailable';
    if (!hadPrompt) return 'retry';
    let opened: Promise<void>;
    try {
      opened = pending.prompt();
    } catch {
      return 'retry';
    }
    deferred = null;
    clearStash();
    publish();
    tracking = true;
    settleChoice(pending, opened);
    return 'opened';
  } catch {
    publish();
    return 'unavailable';
  } finally {
    if (!tracking) prompting = false;
  }
}
