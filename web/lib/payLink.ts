/**
 * A pay link that already says how much, in what, and what for:
 *
 *   /pay/ludarep?amount=50&asset=tusd&for=design%20work
 *
 * The preset is a suggestion the payer reviews, never an instruction: the pay
 * page fills its form from it and the payer still confirms, and the server
 * re-checks every field when the payment is made. Anyone can type these
 * parameters, so nothing here is trusted beyond its shape:
 *   - an amount that is not a plain positive decimal is dropped;
 *   - an asset outside PAY_ASSETS falls back to ETH;
 *   - the note is flattened to one line and capped, because it is shown on a
 *     page that also shows Flizy's own words.
 *
 * Imports nothing but payAsset and sanitize, so node --test loads it directly.
 */

import { normalizePayAsset, type PayAsset } from './payAsset.ts';
import { displaySafeLabel } from './sanitize.ts';

/** The longest note a link carries. Matches payment_requests_note_len and the transfer plan. */
export const PAY_NOTE_MAX = 80;

/** Plain decimal, no sign, no exponent, at most 18 places, and not absurdly long. */
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,18})?$/;

export type PayPreset = {
  amount: string | null;
  asset: PayAsset;
  note: string | null;
};

type Params = Record<string, string | string[] | undefined> | URLSearchParams | null | undefined;

function first(params: Params, key: string): string {
  if (!params) return '';
  if (params instanceof URLSearchParams) return params.get(key) ?? '';
  const v = params[key];
  return String(Array.isArray(v) ? v[0] ?? '' : v ?? '');
}

/**
 * The note as it may be shown or stored: one line, at most PAY_NOTE_MAX
 * characters, or null. displaySafeLabel ends a cut with "...", which would run
 * two past its cap, so the cap it is given leaves room for that.
 */
export function cleanPayNote(raw: unknown): string | null {
  return displaySafeLabel(String(raw ?? ''), PAY_NOTE_MAX - 2) || null;
}

/** What a link asks for, with anything malformed dropped rather than refused. */
export function parsePayPreset(params: Params): PayPreset {
  const rawAmount = first(params, 'amount').trim();
  const amount = AMOUNT_RE.test(rawAmount) && Number(rawAmount) > 0 ? rawAmount : null;
  let asset: PayAsset = 'ETH';
  try {
    asset = normalizePayAsset(first(params, 'asset'));
  } catch {
    asset = 'ETH';
  }
  return { amount, asset, note: cleanPayNote(first(params, 'for')) };
}

/**
 * The link to share for one ask. `base` is the plain pay link
 * (https://flizy.app/pay/ludarep); an empty preset returns it unchanged.
 */
export function buildPayLink(base: string, preset: { amount?: string | null; asset?: PayAsset; note?: string | null }): string {
  const url = new URL(base);
  const amount = String(preset.amount ?? '').trim();
  if (AMOUNT_RE.test(amount) && Number(amount) > 0) url.searchParams.set('amount', amount);
  if (preset.asset && preset.asset !== 'ETH') url.searchParams.set('asset', preset.asset.toLowerCase());
  const note = cleanPayNote(preset.note);
  if (note) url.searchParams.set('for', note);
  return url.toString();
}
