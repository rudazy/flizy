/**
 * The AI collection plan as the screen and the server both see it: rarities,
 * art styles, and the check every model output passes before it is used.
 * No SDK here, so the client screen can import it.
 */

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];
/** Relative weight for each rarity: common appears ten times as often as epic. */
export const RARITY_WEIGHT: Record<Rarity, number> = { common: 50, uncommon: 25, rare: 15, epic: 7, legendary: 3 };

export const ART_STYLES = ['2D', '3D', 'Anime', 'Pixel art', 'Cartoon', 'Realistic', 'Cyberpunk', 'Custom'] as const;

export type PlanTrait = { name: string; rarity: Rarity; prompt: string };
export type PlanCategory = { name: string; traits: PlanTrait[] };
export type CollectionPlan = { name: string; symbol: string; description: string; categories: PlanCategory[] };

export const MAX_CATEGORIES = 8;
export const MAX_TRAITS = 12;

function clean(text: unknown, max: number): string {
  return typeof text === 'string' ? text.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim().slice(0, max) : '';
}

/** Model output to a plan the screen can trust, or an error saying what was wrong. */
export function checkPlan(raw: unknown): CollectionPlan {
  const o = (raw ?? {}) as Record<string, unknown>;
  const categories: PlanCategory[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(o.categories) ? o.categories.slice(0, MAX_CATEGORIES) : []) {
    const cat = (c ?? {}) as Record<string, unknown>;
    const name = clean(cat.name, 40);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const names = new Set<string>();
    const traits: PlanTrait[] = [];
    for (const t of Array.isArray(cat.traits) ? cat.traits.slice(0, MAX_TRAITS) : []) {
      const tr = (t ?? {}) as Record<string, unknown>;
      const traitName = clean(tr.name, 40);
      const rarity = RARITIES.includes(tr.rarity as Rarity) ? (tr.rarity as Rarity) : 'common';
      const prompt = clean(tr.prompt, 400);
      if (!traitName || !prompt || names.has(traitName.toLowerCase())) continue;
      names.add(traitName.toLowerCase());
      traits.push({ name: traitName, rarity, prompt });
    }
    if (traits.length) categories.push({ name, traits });
  }
  if (!categories.length) throw new Error('The plan came back without any traits. Try describing the collection again.');
  return {
    name: clean(o.name, 64) || 'Untitled collection',
    symbol: clean(o.symbol, 16).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'NFT',
    description: clean(o.description, 600),
    categories,
  };
}
