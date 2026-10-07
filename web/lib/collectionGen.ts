/**
 * Layer-based NFT collection generation: trait layers with weights, rules
 * between traits, unique combinations, and standard metadata. Pure, so the
 * creator screen and node tests run the same code.
 *
 * A token is one option from every layer. Layers are drawn in order, which is
 * also the order the art is stacked (first is the bottom). Two tokens never
 * share a full combination. Weights are relative; what a creator sees as a
 * percentage is the weight over its layer's total.
 */

export type TraitOption = { id: string; name: string; weight: number };
export type TraitLayer = { id: string; name: string; options: TraitOption[] };
export type TraitRef = { layer: string; option: string };
/** requires: wherever `when` appears, `then` must too. excludes: `when` and `then` never appear together. */
export type TraitRule = { id: string; kind: 'requires' | 'excludes'; when: TraitRef; then: TraitRef };

export type GeneratedToken = { tokenId: number; picks: Record<string, string> };

export type Generation = {
  tokens: GeneratedToken[];
  /** Fewer tokens than asked: the traits and rules allow only this many unique ones. */
  short: boolean;
};

export const MAX_SUPPLY = 10_000;
/** Combinations are counted exactly up to this many; past it the count is "at least". */
export const COUNT_CAP = 1_000_000;

/** mulberry32: small, fast, deterministic from a seed. Not for anything secret. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function usable(layers: TraitLayer[]): TraitLayer[] {
  return layers
    .map((l) => ({ ...l, options: l.options.filter((o) => Number.isFinite(o.weight) && o.weight > 0) }))
    .filter((l) => l.options.length > 0);
}

function allowed(picks: Record<string, string>, rules: TraitRule[]): boolean {
  for (const r of rules) {
    const hasWhen = picks[r.when.layer] === r.when.option;
    if (!hasWhen) continue;
    const thenPicked = picks[r.then.layer];
    // A rule about a layer not picked yet cannot be judged; it is checked again when it is.
    if (thenPicked === undefined) continue;
    if (r.kind === 'requires' && thenPicked !== r.then.option) return false;
    if (r.kind === 'excludes' && thenPicked === r.then.option) return false;
  }
  return true;
}

/** Same rules, read in both directions, so a partial pick can be judged from either side. */
function bothWays(rules: TraitRule[]): TraitRule[] {
  const out: TraitRule[] = [];
  for (const r of rules) {
    out.push(r);
    if (r.kind === 'excludes') out.push({ ...r, when: r.then, then: r.when });
  }
  return out;
}

/**
 * How many distinct tokens the layers and rules allow. Exact up to COUNT_CAP;
 * `atLeast` is true when counting stopped there.
 */
export function countCombinations(layers: TraitLayer[], rules: TraitRule[] = []): { count: number; atLeast: boolean } {
  const ls = usable(layers);
  if (!ls.length) return { count: 0, atLeast: false };
  const rs = bothWays(rules);
  if (!rs.length) {
    let product = 1;
    for (const l of ls) {
      product *= l.options.length;
      if (product >= COUNT_CAP) return { count: COUNT_CAP, atLeast: true };
    }
    return { count: product, atLeast: false };
  }
  let count = 0;
  const picks: Record<string, string> = {};
  const walk = (i: number): boolean => {
    if (i === ls.length) {
      // "requires" on a layer drawn earlier is settled only now.
      if (allowed(picks, rs)) count += 1;
      return count >= COUNT_CAP;
    }
    for (const o of ls[i].options) {
      picks[ls[i].id] = o.id;
      if (allowed(picks, rs) && walk(i + 1)) return true;
    }
    delete picks[ls[i].id];
    return false;
  };
  const capped = walk(0);
  return { count, atLeast: capped };
}

function pick(options: TraitOption[], rand: () => number): TraitOption {
  const total = options.reduce((s, o) => s + o.weight, 0);
  let x = rand() * total;
  for (const o of options) {
    x -= o.weight;
    if (x < 0) return o;
  }
  return options[options.length - 1];
}

/**
 * `supply` unique tokens, numbered from 1, drawn by weight. Gives up after a
 * bounded number of draws and returns what it has with `short` set, instead of
 * looping on traits that cannot make that many.
 */
export function generateCollection(
  layers: TraitLayer[],
  rules: TraitRule[],
  supply: number,
  seed: number
): Generation {
  const ls = usable(layers);
  const target = Math.max(0, Math.min(MAX_SUPPLY, Math.floor(supply)));
  if (!ls.length || target === 0) return { tokens: [], short: target > 0 };
  const rs = bothWays(rules);
  const rand = seededRandom(seed);
  const seen = new Set<string>();
  const tokens: GeneratedToken[] = [];
  const maxDraws = target * 60 + 1000;
  for (let draw = 0; draw < maxDraws && tokens.length < target; draw += 1) {
    const picks: Record<string, string> = {};
    let ok = true;
    for (const l of ls) {
      // Only options the rules allow next to what is already picked.
      const fits = l.options.filter((o) => allowed({ ...picks, [l.id]: o.id }, rs));
      if (!fits.length) {
        ok = false;
        break;
      }
      picks[l.id] = pick(fits, rand).id;
    }
    if (!ok || !allowed(picks, rs)) continue;
    const key = ls.map((l) => picks[l.id]).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ tokenId: tokens.length + 1, picks });
  }
  return { tokens, short: tokens.length < target };
}

/** Expected count of each option for `supply` tokens, by weight. An estimate, not a promise. */
export function expectedCounts(layer: TraitLayer, supply: number): Array<{ option: TraitOption; percent: number; expected: number }> {
  const options = layer.options.filter((o) => o.weight > 0);
  const total = options.reduce((s, o) => s + o.weight, 0);
  return layer.options.map((option) => {
    const share = total > 0 && option.weight > 0 ? option.weight / total : 0;
    return { option, percent: share * 100, expected: Math.round(share * supply) };
  });
}

/** How often each option actually came out. */
export function actualCounts(layer: TraitLayer, tokens: GeneratedToken[]): Map<string, number> {
  const out = new Map<string, number>(layer.options.map((o) => [o.id, 0]));
  for (const t of tokens) {
    const id = t.picks[layer.id];
    if (id !== undefined) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** "#001" style, padded to the width of the supply. */
export function tokenLabel(tokenId: number, supply: number): string {
  const width = Math.max(3, String(Math.max(1, supply)).length);
  return `#${String(tokenId).padStart(width, '0')}`;
}

/** Standard ERC-721 metadata for one token: name, description, image and attributes. */
export function tokenMetadata(
  collection: { name: string; description: string },
  layers: TraitLayer[],
  token: GeneratedToken,
  image: string
) {
  const attributes: Array<{ trait_type: string; value: string }> = [];
  for (const l of layers) {
    const option = l.options.find((o) => o.id === token.picks[l.id]);
    if (option) attributes.push({ trait_type: l.name, value: option.name });
  }
  return {
    name: `${collection.name} #${token.tokenId}`,
    description: collection.description,
    image,
    attributes,
  };
}

export type Check = { ok: boolean; label: string };

const PLAIN_NAME = /^[\x20-\x7e]{1,64}$/;

/** The validation list the creator sees before launch. */
export function validateCollection(
  layers: TraitLayer[],
  rules: TraitRule[],
  supply: number,
  generation: Generation | null
): Check[] {
  const ls = usable(layers);
  const names = layers.map((l) => l.name.trim().toLowerCase());
  const { count, atLeast } = countCombinations(layers, rules);
  const checks: Check[] = [
    { ok: ls.length > 0 && ls.length === layers.length, label: 'Every trait category has at least one trait with a weight' },
    { ok: new Set(names).size === names.length && names.every(Boolean), label: 'Trait categories have unique names' },
    {
      // What the stored metadata accepts: printable ASCII, up to 64 characters.
      ok: layers.every((l) => PLAIN_NAME.test(l.name.trim()) && l.options.every((o) => PLAIN_NAME.test(o.name.trim()))),
      label: 'Category and trait names use plain letters, numbers and symbols',
    },
    {
      ok: atLeast || count >= supply,
      label: atLeast || count >= supply
        ? `Enough unique combinations for ${supply.toLocaleString('en-US')} NFTs`
        : `Your traits can make only ${count.toLocaleString('en-US')} unique NFTs. Add traits or lower the supply.`,
    },
  ];
  if (generation) {
    const keys = new Set(generation.tokens.map((t) => ls.map((l) => t.picks[l.id]).join('|')));
    checks.push({ ok: keys.size === generation.tokens.length, label: 'No duplicate combinations' });
    checks.push({ ok: generation.tokens.length === supply, label: `${generation.tokens.length.toLocaleString('en-US')} of ${supply.toLocaleString('en-US')} NFTs generated` });
    checks.push({ ok: generation.tokens.every((t) => allowed(t.picks, bothWays(rules))), label: 'Every NFT follows the trait rules' });
  }
  return checks;
}
