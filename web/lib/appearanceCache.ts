/**
 * The signed-in account's background, remembered in this browser so the first
 * paint can use it. The value is mode, preset, dim and version. Never the
 * file, and never an account id. Storage failures fall through to the default.
 */

import {
  APPEARANCE_PRESETS,
  isAppearancePreset,
  parseAppearanceCache,
  type PublicAppearance,
} from './appearance.ts';

export const APPEARANCE_CACHE_KEY = 'flizy.appearance';

export const APPEARANCE_BOOT_SCRIPT = `(function(){try{var raw=localStorage.getItem(${JSON.stringify(APPEARANCE_CACHE_KEY)});if(!raw)return;var a=JSON.parse(raw);if(!a||typeof a.mode!=='string')return;var root=document.documentElement;var bg=document.getElementById('flizy-app-bg');if(a.mode==='preset'){var allowed=['${APPEARANCE_PRESETS.join("','")}'];var hit=false;if(typeof a.preset==='string'){for(var i=0;i<allowed.length;i++){if(allowed[i]===a.preset)hit=true;}}if(!hit)return;root.setAttribute('data-flizy-preset',a.preset);return;}if(a.mode==='image'&&bg){var dim=Number(a.dim);if(!isFinite(dim)||dim<0||dim>90)dim=60;var version=Number(a.version);if(!isFinite(version)||version<=0)return;root.setAttribute('data-flizy-preset','image');bg.style.backgroundImage='url("/api/account/background/image?v='+encodeURIComponent(String(version))+'")';bg.style.backgroundSize='cover';bg.style.backgroundPosition='center';bg.style.setProperty('--app-bg-dim',String(dim/100));}}catch(e){}})();`;

export function readAppearanceCache(): PublicAppearance | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(APPEARANCE_CACHE_KEY);
    if (!raw) return null;
    return parseAppearanceCache(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeAppearanceCache(value: PublicAppearance): void {
  try {
    localStorage.setItem(
      APPEARANCE_CACHE_KEY,
      JSON.stringify({
        mode: value.mode,
        preset: value.preset,
        dim: value.dim,
        version: value.version,
      })
    );
  } catch {
    // Private mode, a full disk, or a denied store. The default still paints.
  }
}

export function clearAppearanceCache(): void {
  try {
    localStorage.removeItem(APPEARANCE_CACHE_KEY);
  } catch {
    // Same as a write failure: nothing to clear, nothing to show.
  }
}

/** Paint the fixed layer. It is a sibling of the shell, not a wrapper. */
export function applyAppearance(value: PublicAppearance): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const bg = document.getElementById('flizy-app-bg');
  root.removeAttribute('data-flizy-preset');
  if (bg) {
    bg.style.removeProperty('background-image');
    bg.style.removeProperty('background-size');
    bg.style.removeProperty('background-position');
    bg.style.removeProperty('--app-bg-dim');
  }
  if (value.mode === 'preset' && isAppearancePreset(value.preset)) {
    root.setAttribute('data-flizy-preset', value.preset);
    return;
  }
  if (value.mode === 'image' && bg && value.version > 0) {
    root.setAttribute('data-flizy-preset', 'image');
    bg.style.backgroundImage = `url("/api/account/background/image?v=${encodeURIComponent(String(value.version))}")`;
    bg.style.backgroundSize = 'cover';
    bg.style.backgroundPosition = 'center';
    bg.style.setProperty('--app-bg-dim', String(value.dim / 100));
  }
}
