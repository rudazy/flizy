'use client';

import { useEffect, useState } from 'react';
import { APPEARANCE_PRESETS, DEFAULT_APPEARANCE, type AppearancePreset, type PublicAppearance } from '../lib/appearance';
import { ChevronDownIcon } from './ExploreIcons';
import { useLocale } from './LocaleProvider';
import { useDashboard } from './DashboardProvider';
import type { MessageKey } from '../lib/i18n/messages';

const PRESET_KEY: Record<AppearancePreset, MessageKey> = {
  wine: 'account.backgroundWine',
  green: 'account.backgroundGreen',
  gold: 'account.backgroundGold',
  yellow: 'account.backgroundYellow',
  white: 'account.backgroundWhite',
};

const MAX_EDGE = 1920;
const QUALITY = 0.8;

/**
 * Profile control for the dashboard background. The choice is this account's
 * alone. Success is quiet. A failure stays in this section.
 */
export function AccountBackground() {
  const { t } = useLocale();
  const { data, patchAppearance } = useDashboard();
  const current = data?.appearance ?? DEFAULT_APPEARANCE;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ url: string; blob: Blob } | null>(null);
  const [dim, setDim] = useState(current.dim);

  useEffect(() => {
    if (!preview) setDim(current.dim);
  }, [current.dim, preview]);

  async function choose(next: { mode: 'default' } | { mode: 'preset'; preset: AppearancePreset }) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/account/background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof json.error === 'string' ? json.error : 'Something went wrong. Please try again.');
        return;
      }
      if (json.appearance) patchAppearance(json.appearance as PublicAppearance);
      clearPreview();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | null) {
    setError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Use a WebP, JPEG or PNG image.');
      return;
    }
    try {
      const blob = await prepareBackgroundFile(file);
      const url = await dataUrlOf(blob);
      setDim(current.mode === 'image' ? current.dim : DEFAULT_APPEARANCE.dim);
      setPreview({ url, blob });
    } catch {
      setError('Use a WebP, JPEG or PNG image.');
    }
  }

  async function saveImage() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.set('file', preview.blob, preview.blob.type === 'image/jpeg' ? 'background.jpg' : 'background.webp');
      form.set('dim', String(dim));
      const res = await fetch('/api/account/background/image', { method: 'POST', body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof json.error === 'string' ? json.error : 'Something went wrong. Please try again.');
        return;
      }
      if (json.appearance) patchAppearance(json.appearance as PublicAppearance);
      clearPreview();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function saveDim(nextDim: number) {
    if (current.mode !== 'image' || preview) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/account/background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'image', dim: nextDim }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof json.error === 'string' ? json.error : 'Something went wrong. Please try again.');
        return;
      }
      if (json.appearance) patchAppearance(json.appearance as PublicAppearance);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function clearPreview() {
    setPreview(null);
  }

  const selected = preview ? null : current.mode === 'preset' ? current.preset : current.mode === 'default' ? 'default' : null;

  return (
    <details className="group rounded-[16px] border border-[#2a2b30] bg-[#101012]">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-start gap-3 px-3.5 py-3.5 text-left [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block font-sans text-[15px] font-semibold leading-tight text-white">{t('account.background')}</span>
          <span className="mt-0.5 block font-sans text-[12px] leading-snug text-[#8d867c]">{t('account.backgroundHint')}</span>
        </span>
        <ChevronDownIcon size={16} className="mt-0.5 shrink-0 text-[#8d867c] transition-transform group-open:rotate-180" />
      </summary>
      <div className="grid grid-cols-3 gap-1.5 border-t border-[#26262a] px-3.5 py-3">
        <Choice
          label={t('account.backgroundDefault')}
          selected={selected === 'default'}
          disabled={busy}
          onClick={() => void choose({ mode: 'default' })}
        />
        {APPEARANCE_PRESETS.map((id) => (
          <Choice
            key={id}
            label={t(PRESET_KEY[id])}
            selected={selected === id}
            disabled={busy}
            onClick={() => void choose({ mode: 'preset', preset: id })}
          />
        ))}
      </div>
      {preview ? (
        <div className="px-3.5 pb-3">
          <p className="mb-1.5 font-sans text-[12px] text-[#8d867c]">{t('account.backgroundPreview')}</p>
          <div className="relative h-28 overflow-hidden rounded-[12px] border border-[#2a2b30]">
            {/* Preview of the file the person just picked. Decorative behind the dim. */}
            <img src={preview.url} alt="" className="h-full w-full object-cover" />
            <div className="absolute inset-0 bg-black" style={{ opacity: dim / 100 }} />
          </div>
        </div>
      ) : null}
      {preview || current.mode === 'image' ? (
        <label className="block px-3.5 pb-3">
          <span className="mb-1.5 flex items-center justify-between font-sans text-[12px] text-[#c8c2b8]">
            <span>{t('account.backgroundDim')}</span>
            <span className="font-mono text-[11px] text-[#8d867c]">{dim}</span>
          </span>
          <input
            type="range"
            min={0}
            max={90}
            step={1}
            value={dim}
            disabled={busy}
            aria-label={t('account.backgroundDim')}
            className="h-11 w-full accent-[#f5c842]"
            onChange={(event) => {
              const next = Number(event.target.value);
              setDim(next);
            }}
            onPointerUp={(event) => {
              const next = Number((event.target as HTMLInputElement).value);
              if (!preview) void saveDim(next);
            }}
            onBlur={(event) => {
              const next = Number(event.target.value);
              if (!preview && next !== current.dim) void saveDim(next);
            }}
          />
        </label>
      ) : null}
      <div className="flex flex-wrap gap-2 px-3.5 pb-3.5">
        <label className="inline-flex min-h-[44px] cursor-pointer items-center rounded-[10px] border border-[#3a3424] px-3 font-sans text-[13px] text-[#f3f1ec]">
          {t('account.backgroundUpload')}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0] || null;
              event.target.value = '';
              void onFile(file);
            }}
          />
        </label>
        {preview ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void saveImage()}
            className="inline-flex min-h-[44px] items-center rounded-[10px] border border-[#f5c842] px-3 font-sans text-[13px] font-semibold text-[#f5c842] disabled:opacity-45"
          >
            {busy ? t('account.backgroundSaving') : t('account.backgroundSave')}
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy || (current.mode === 'default' && !preview)}
          onClick={() => void choose({ mode: 'default' })}
          className="inline-flex min-h-[44px] items-center rounded-[10px] border border-[#3a3424] px-3 font-sans text-[13px] text-[#c8c2b8] disabled:opacity-45"
        >
          {t('account.backgroundReset')}
        </button>
      </div>
      {error ? (
        <p className="px-3.5 pb-3.5 font-sans text-[12px] text-[#f0a3a3]" role="alert">
          {error}
        </p>
      ) : null}
    </details>
  );
}

function Choice({
  label,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={`min-h-[44px] rounded-[10px] border px-2 font-sans text-[13px] disabled:opacity-45 ${
        selected
          ? 'border-[#f5c842] bg-[#241f16] text-[#f5c842]'
          : 'border-[#3a3424] text-[#f3f1ec]'
      }`}
    >
      {label}
    </button>
  );
}

function blobOf(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('preview'));
    };
    reader.onerror = () => reject(new Error('preview'));
    reader.readAsDataURL(blob);
  });
}

/** Resize and re-encode. Drawing to a canvas drops EXIF, including location. */
async function prepareBackgroundFile(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const webp = await blobOf(canvas, 'image/webp', QUALITY);
    if (webp && webp.size > 0 && webp.type === 'image/webp') return webp;
    const jpeg = await blobOf(canvas, 'image/jpeg', QUALITY);
    if (jpeg && jpeg.size > 0) return jpeg;
    throw new Error('export');
  } finally {
    bitmap.close();
  }
}
