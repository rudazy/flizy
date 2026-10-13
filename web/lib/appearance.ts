/**
 * Dashboard background themes. Each preset is a full token set.
 * Dark presets keep light text and the gold accent. Light presets use dark
 * text and a darker gold so the accent still reads on a light field.
 * Uploaded images do not use these tokens. They keep the build's dark theme
 * and a black overlay.
 */

export const APPEARANCE_PRESETS = ['wine', 'green', 'gold', 'yellow', 'white'] as const;

export type AppearancePreset = (typeof APPEARANCE_PRESETS)[number];
export type AppearanceMode = 'default' | 'preset' | 'image';

export type PublicAppearance = {
  mode: AppearanceMode;
  preset: AppearancePreset | null;
  dim: number;
  version: number;
};

export const DEFAULT_APPEARANCE: PublicAppearance = {
  mode: 'default',
  preset: null,
  dim: 60,
  version: 0,
};

export type AppearanceTokens = {
  id: AppearancePreset;
  /** Light field. Text and the nav switch to dark. */
  light: boolean;
  bg: string;
  surface: string;
  text: string;
  secondary: string;
  accent: string;
  buttonBg: string;
  buttonText: string;
  navBg: string;
  navText: string;
  navActive: string;
};

export const PRESETS: readonly AppearanceTokens[] = [
  {
    id: 'wine',
    light: false,
    bg: '#2a1218',
    surface: '#1a0c10',
    text: '#f6eee8',
    secondary: '#e4ccc8',
    accent: '#f5c842',
    buttonBg: '#f5c842',
    buttonText: '#1a1408',
    navBg: '#14080c',
    navText: '#f6eee8',
    navActive: '#f5c842',
  },
  {
    id: 'green',
    light: false,
    bg: '#10261a',
    surface: '#0c1c14',
    text: '#e8f2e6',
    secondary: '#c9dcc8',
    accent: '#e0b84a',
    buttonBg: '#e0b84a',
    buttonText: '#1a1408',
    navBg: '#0c1c14',
    navText: '#e8f2e6',
    navActive: '#f5c842',
  },
  {
    id: 'gold',
    light: true,
    bg: '#f3e2a6',
    surface: '#fff6d8',
    text: '#2a1c08',
    secondary: '#5c4314',
    accent: '#7a4e0c',
    buttonBg: '#7a4e0c',
    buttonText: '#fff8e8',
    navBg: '#f8edc4',
    navText: '#2a1c08',
    navActive: '#6b4208',
  },
  {
    id: 'yellow',
    light: true,
    bg: '#f6eeb0',
    surface: '#fff9d6',
    text: '#2a2208',
    secondary: '#5e4810',
    accent: '#7a5608',
    buttonBg: '#7a5608',
    buttonText: '#fff8e4',
    navBg: '#fbf6cc',
    navText: '#2a2208',
    navActive: '#6a4806',
  },
  {
    id: 'white',
    light: true,
    bg: '#f7f5f1',
    surface: '#fffcf8',
    text: '#1c1916',
    secondary: '#5c564e',
    accent: '#7a5610',
    buttonBg: '#1c1916',
    buttonText: '#f7f5f1',
    navBg: '#f3f0ea',
    navText: '#1c1916',
    navActive: '#7a5610',
  },
];

export function presetById(id: string | null | undefined): AppearanceTokens | null {
  if (!id) return null;
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

/** WCAG relative luminance contrast. 4.5 is AA for normal text. */
export function contrastRatio(foreground: string, background: string): number {
  const hi = Math.max(luminance(foreground), luminance(background));
  const lo = Math.min(luminance(foreground), luminance(background));
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastPair = {
  name: string;
  fg: string;
  bg: string;
  min: number;
};

/** Pairs that must pass AA for one preset. */
export function contrastPairs(preset: AppearanceTokens): ContrastPair[] {
  return [
    { name: 'body', fg: preset.text, bg: preset.bg, min: 4.5 },
    { name: 'secondary on background', fg: preset.secondary, bg: preset.bg, min: 4.5 },
    { name: 'secondary on surface', fg: preset.secondary, bg: preset.surface, min: 4.5 },
    { name: 'button', fg: preset.buttonText, bg: preset.buttonBg, min: 4.5 },
    { name: 'nav', fg: preset.navText, bg: preset.navBg, min: 4.5 },
    { name: 'nav active', fg: preset.navActive, bg: preset.navBg, min: 4.5 },
    { name: 'accent on background', fg: preset.accent, bg: preset.bg, min: 4.5 },
  ];
}

function luminance(hex: string): number {
  const raw = hex.replace('#', '');
  const r = channel(parseInt(raw.slice(0, 2), 16));
  const g = channel(parseInt(raw.slice(2, 4), 16));
  const b = channel(parseInt(raw.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function isAppearancePreset(value: unknown): value is AppearancePreset {
  return typeof value === 'string' && (APPEARANCE_PRESETS as readonly string[]).includes(value);
}

/** A cached choice is only applied when every field is one we would have written. */
export function parseAppearanceCache(value: unknown): PublicAppearance | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { mode?: unknown; preset?: unknown; dim?: unknown; version?: unknown };
  const dim = typeof row.dim === 'number' && Number.isInteger(row.dim) ? row.dim : null;
  const version = typeof row.version === 'number' && Number.isInteger(row.version) ? row.version : null;
  if (dim == null || dim < 0 || dim > 90) return null;
  if (version == null || version < 0 || version > 1_000_000) return null;
  if (row.mode === 'default' && (row.preset == null || row.preset === '')) {
    return { mode: 'default', preset: null, dim, version };
  }
  if (row.mode === 'preset' && isAppearancePreset(row.preset)) {
    return { mode: 'preset', preset: row.preset, dim, version };
  }
  if (row.mode === 'image' && (row.preset == null || row.preset === '')) {
    return { mode: 'image', preset: null, dim, version };
  }
  return null;
}
