/**
 * Inlined into the document head so the listener exists before hydration.
 * Chromium fires beforeinstallprompt once per load. After an uninstall that
 * can happen before React attaches, and a second file download can miss it.
 */
export const INSTALL_CAPTURE_JS = `(function(){if(window.__flizyInstallBound)return;window.__flizyInstallBound=true;window.__flizyInstallPrompt=null;window.addEventListener('beforeinstallprompt',function(event){event.preventDefault();window.__flizyInstallPrompt=event;window.dispatchEvent(new Event('flizy-install-ready'));});window.addEventListener('appinstalled',function(){window.__flizyInstallPrompt=null;window.dispatchEvent(new Event('flizy-install-done'));});if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){});}})();`;
