'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  countCombinations,
  expectedCounts,
  generateCollection,
  tokenLabel,
  tokenMetadata,
  validateCollection,
  MAX_SUPPLY,
  type Generation,
  type GeneratedToken,
  type TraitLayer,
  type TraitRule,
} from '../lib/collectionGen';
import { CheckIcon, ChevronDownIcon, PlusIcon, TrashIcon } from './ExploreIcons';
import { GeneratedLaunch, type StoredRun } from './GeneratedLaunch';

/** A trait as the screen holds it: the layer image is a data URL kept in this tab only. */
export type Trait = { id: string; name: string; weight: number; art: string };
export type Category = { id: string; name: string; traits: Trait[] };

/** A collection handed over from Generate with AI, opened at the traits step. */
export type CreatorStart = { name: string; symbol: string; description: string; supply: number; categories: Category[] };

const STEPS = ['Details', 'Artwork', 'Traits', 'Rarity', 'Preview', 'Launch'] as const;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_TRAITS = 400;
const SAMPLE = 12;

const INPUT =
  'h-[44px] w-full rounded-[8px] border border-[#2a2b30] bg-[#0b0b0c] px-[12px] font-sans text-[14px] text-white outline-none focus:border-sun/70';
const CARD = 'rounded-[12px] border border-[#23242a] bg-[#0d0d0e] p-[14px]';

/** Printable ASCII without quotes or backslashes, as the existing manual flow requires. */
function plain(text: string, max: number): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= max && /^[\x20-\x7e]+$/.test(t) && !/["\\]/.test(t);
}

function httpsOrEmpty(url: string): boolean {
  const t = url.trim();
  return !t || /^https:\/\/[\x21-\x7e]{1,300}$/.test(t);
}

let nextId = 1;
export const newId = (prefix: string) => `${prefix}${nextId++}`;

/** A short fingerprint of a run's picks, so stored images are reused only for the same NFTs. */
function runFingerprint(tokens: GeneratedToken[]): string {
  let h = 0x811c9dc5;
  for (const t of tokens) {
    for (const [k, v] of Object.entries(t.picks)) {
      for (const ch of `${t.tokenId}:${k}=${v};`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    }
  }
  return `${tokens.length}-${h.toString(36)}`;
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('read')));
    reader.onerror = () => reject(reader.error ?? new Error('read'));
    reader.readAsDataURL(file);
  });
}

/** "neon_gold-01.png" becomes "Neon Gold 01". */
function traitName(file: string): string {
  const base = file.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  return (base || 'Trait').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
}

function toLayers(categories: Category[]): TraitLayer[] {
  return categories.map((c) => ({ id: c.id, name: c.name, options: c.traits.map((t) => ({ id: t.id, name: t.name, weight: t.weight })) }));
}

/**
 * Create with Flizy: a collection built from the creator's own artwork layers.
 * Flizy combines one trait from every category into unique NFTs, by weight and
 * within the creator's rules, and writes standard metadata for each. Layers
 * stay in this browser tab; at launch only the finished NFT images and their
 * metadata are stored, after the generation fee is paid.
 */
export function CollectionCreator({ onBack, start }: { onBack: () => void; start?: CreatorStart | null }) {
  const [step, setStep] = useState(start ? 3 : 1);
  const [name, setName] = useState(start?.name ?? '');
  const [symbol, setSymbol] = useState(start?.symbol ?? '');
  const [supply, setSupply] = useState(start ? String(start.supply) : '1000');
  const [description, setDescription] = useState(start?.description ?? '');
  const [creator, setCreator] = useState('');
  const [website, setWebsite] = useState('');
  const [social, setSocial] = useState('');
  const [royalty, setRoyalty] = useState('5');
  const [categories, setCategories] = useState<Category[]>(start?.categories ?? []);
  const [newCategory, setNewCategory] = useState('');
  const [mode, setMode] = useState<'equal' | 'weighted'>('weighted');
  const [rules, setRules] = useState<TraitRule[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const [picked, setPicked] = useState<GeneratedToken | null>(null);
  const [error, setError] = useState('');
  const [stored, setStored] = useState<StoredRun | null>(null);

  const supplyN = Number(supply);
  const traitCount = categories.reduce((s, c) => s + c.traits.length, 0);
  const layers = useMemo(() => {
    const ls = toLayers(categories);
    return mode === 'equal' ? ls.map((l) => ({ ...l, options: l.options.map((o) => ({ ...o, weight: 1 })) })) : ls;
  }, [categories, mode]);
  const combos = useMemo(() => countCombinations(layers, rules), [layers, rules]);

  const detailProblems: string[] = [];
  if (!plain(name, 64)) detailProblems.push('Collection name: 1 to 64 plain characters, no quotes or backslashes.');
  if (!plain(symbol, 16)) detailProblems.push('Symbol: 1 to 16 plain characters.');
  if (!Number.isInteger(supplyN) || supplyN < 1 || supplyN > MAX_SUPPLY) {
    detailProblems.push(`Supply: a whole number from 1 to ${MAX_SUPPLY.toLocaleString('en-US')}.`);
  }
  if (!/^[0-9]{1,2}(\.[0-9]{1,2})?$/.test(royalty.trim()) || Number(royalty) > 10) detailProblems.push('Creator royalty: 0 to 10%.');
  if (!httpsOrEmpty(website) || !httpsOrEmpty(social)) detailProblems.push('Links start with https://.');

  const artProblems: string[] = [];
  if (!categories.length) artProblems.push('Add at least one trait category.');
  for (const c of categories) if (!c.traits.length) artProblems.push(`${c.name}: upload at least one image.`);

  // The full run is what Preview and Launch validate; the sample is its first tokens.
  const generation: Generation | null = useMemo(() => {
    if (step < 5 || artProblems.length || detailProblems.length) return null;
    return generateCollection(layers, rules, supplyN, seed);
  }, [step, layers, rules, supplyN, seed, artProblems.length, detailProblems.length]);
  const checks = useMemo(() => validateCollection(layers, rules, supplyN, generation), [layers, rules, supplyN, generation]);
  const runKey = useMemo(() => (generation ? `${mode}|${runFingerprint(generation.tokens)}` : ''), [generation, mode]);

  function go(n: number) {
    if (n > 1 && detailProblems.length) {
      setStep(1);
      setError(detailProblems[0]);
      return;
    }
    if (n > 2 && artProblems.length) {
      setStep(2);
      setError(artProblems[0]);
      return;
    }
    setError('');
    setPicked(null);
    setStep(n);
    window.scrollTo({ top: 0 });
  }

  function addCategory() {
    const label = newCategory.trim().slice(0, 40);
    if (!label) return;
    if (categories.some((c) => c.name.toLowerCase() === label.toLowerCase())) {
      setError(`There is already a ${label} category.`);
      return;
    }
    setCategories((prev) => [...prev, { id: newId('c'), name: label, traits: [] }]);
    setNewCategory('');
    setError('');
  }

  async function addFiles(categoryId: string, files: FileList | null) {
    if (!files?.length) return;
    const list = [...files];
    if (traitCount + list.length > MAX_TRAITS) {
      setError(`A collection can use up to ${MAX_TRAITS} trait images.`);
      return;
    }
    const added: Trait[] = [];
    for (const file of list) {
      if (!/^image\/(png|webp|jpeg)$/.test(file.type)) {
        setError(`${file.name}: use PNG, WebP or JPG. PNG keeps transparent layers.`);
        continue;
      }
      if (file.size > IMAGE_MAX_BYTES) {
        setError(`${file.name}: keep each layer at 2 MB or less.`);
        continue;
      }
      try {
        added.push({ id: newId('t'), name: traitName(file.name), weight: 10, art: await readImage(file) });
      } catch {
        setError(`${file.name}: could not read that image.`);
      }
    }
    setCategories((prev) => prev.map((c) => (c.id === categoryId ? { ...c, traits: [...c.traits, ...added] } : c)));
  }

  function updateCategory(id: string, change: (c: Category) => Category | null) {
    setCategories((prev) => prev.flatMap((c) => {
      if (c.id !== id) return [c];
      const next = change(c);
      return next ? [next] : [];
    }));
  }

  function move(id: string, by: -1 | 1) {
    setCategories((prev) => {
      const i = prev.findIndex((c) => c.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  const art = (token: GeneratedToken) =>
    categories.map((c) => c.traits.find((t) => t.id === token.picks[c.id])).filter((t): t is Trait => !!t);

  return (
    <div className="grid gap-[14px]">
      <button type="button" onClick={onBack} className="hit-y-44 justify-self-start font-sans text-[12px] text-[#cfcfcf]">
        Change how you create
      </button>
      <div>
        <h2 className="m-0 font-sans text-[18px] font-bold text-white">Create with Flizy</h2>
        <p className="m-0 mt-[3px] font-sans text-[12.5px] text-[#a9a9a9]">Build a collection from your own artwork layers.</p>
      </div>

      <ol className="m-0 flex list-none flex-wrap gap-[6px] p-0" aria-label="Steps">
        {STEPS.map((label, i) => {
          const n = i + 1;
          return (
            <li key={label}>
              <button
                type="button"
                onClick={() => go(n)}
                aria-current={n === step ? 'step' : undefined}
                className={`hit-y-44 flex h-[30px] items-center gap-[6px] rounded-full border px-[10px] font-sans text-[12px] ${
                  n === step ? 'border-sun bg-sun-wash text-sun' : n < step ? 'border-[#4a3d1c] text-[#e6c88a]' : 'border-[#2a2b30] text-[#a9a9a9]'
                }`}
              >
                <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] ${n === step ? 'bg-sun text-sun-ink' : 'bg-[#1a1a1c]'}`}>
                  {n < step ? <CheckIcon size={10} strokeWidth={3} /> : n}
                </span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      {step === 1 ? (
        <section className={`${CARD} grid gap-[12px]`}>
          <Heading title="Collection details" text="Tell us about your collection." />
          <Field label="Collection name">
            <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="Franky the Frog" />
          </Field>
          <Field label="Symbol">
            <input className={INPUT} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} maxLength={16} placeholder="FRANK" />
          </Field>
          <Field label="Collection supply" hint="Maximum number of NFTs that can exist in this collection.">
            <input className={INPUT} inputMode="numeric" value={supply} onChange={(e) => setSupply(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))} />
          </Field>
          <Field label="Description (optional)">
            <textarea
              className="min-h-[84px] w-full rounded-[8px] border border-[#2a2b30] bg-[#0b0b0c] p-[12px] font-sans text-[14px] text-white outline-none focus:border-sun/70"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </Field>
          <div className="grid gap-[12px] sm:grid-cols-2">
            <Field label="Creator name (optional)">
              <input className={INPUT} value={creator} onChange={(e) => setCreator(e.target.value)} maxLength={64} />
            </Field>
            <Field label="Website (optional)">
              <input className={INPUT} value={website} onChange={(e) => setWebsite(e.target.value.trim())} placeholder="https://" autoComplete="off" />
            </Field>
            <Field label="Social link (optional)" hint="X, Telegram or Discord, as an https:// link.">
              <input className={INPUT} value={social} onChange={(e) => setSocial(e.target.value.trim())} placeholder="https://x.com/..." autoComplete="off" />
            </Field>
            <Field label="Creator royalty (%)" hint="Creator royalties are paid to your wallet from eligible secondary sales. 0 to 10%.">
              <input className={INPUT} inputMode="decimal" value={royalty} onChange={(e) => setRoyalty(e.target.value)} />
            </Field>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className={`${CARD} grid gap-[12px]`}>
          <Heading
            title="Add your artwork"
            text="Upload the layers that Flizy will use to generate your NFTs. Each category is one layer; the first sits at the bottom. Use PNG with transparency for everything above the background."
          />
          {categories.map((c, i) => (
            <div key={c.id} className="grid gap-[8px] rounded-[10px] border border-[#23242a] bg-[#0b0b0c] p-[10px]">
              <div className="flex flex-wrap items-center gap-[8px]">
                <input
                  className="h-[36px] min-w-0 flex-1 rounded-[6px] border border-[#2a2b30] bg-transparent px-[10px] font-sans text-[14px] font-semibold text-white outline-none focus:border-sun/70"
                  value={c.name}
                  aria-label="Category name"
                  onChange={(e) => updateCategory(c.id, (x) => ({ ...x, name: e.target.value.slice(0, 40) }))}
                />
                <span className="font-sans text-[12px] text-[#a9a9a9]">{c.traits.length} {c.traits.length === 1 ? 'asset' : 'assets'}</span>
                <SmallButton label="Move up" disabled={i === 0} onClick={() => move(c.id, -1)}>
                  <ChevronDownIcon size={13} className="rotate-180" />
                </SmallButton>
                <SmallButton label="Move down" disabled={i === categories.length - 1} onClick={() => move(c.id, 1)}>
                  <ChevronDownIcon size={13} />
                </SmallButton>
                <SmallButton label={`Delete ${c.name}`} onClick={() => updateCategory(c.id, () => null)}>
                  <TrashIcon size={13} />
                </SmallButton>
              </div>
              {c.traits.length ? (
                <div className="grid grid-cols-4 gap-[6px] sm:grid-cols-6 lg:grid-cols-8">
                  {c.traits.map((t) => (
                    <img key={t.id} src={t.art} alt={t.name} title={t.name} className="aspect-square w-full rounded-[6px] border border-[#23242a] bg-[#151517] object-contain" />
                  ))}
                </div>
              ) : null}
              <label className="flex h-[40px] cursor-pointer items-center justify-center gap-[6px] rounded-[8px] border border-dashed border-[#3a3b40] font-sans text-[13px] text-[#e6e6e6] focus-within:border-sun/70 hover:border-[#55565c]">
                <PlusIcon size={13} /> Upload {c.name} images
                <input
                  type="file"
                  multiple
                  accept="image/png,image/webp,image/jpeg"
                  className="sr-only"
                  onChange={(e) => {
                    void addFiles(c.id, e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          ))}
          <div className="flex gap-[8px]">
            <input
              className={INPUT}
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCategory();
                }
              }}
              placeholder={categories.length ? 'Eyes, Headwear, Accessories...' : 'Background'}
              maxLength={40}
              aria-label="New trait category"
            />
            <button type="button" onClick={addCategory} disabled={!newCategory.trim()} className="btn-sun h-[44px] shrink-0 gap-[6px] rounded-[8px] px-[14px] font-sans text-[13px] disabled:opacity-50">
              <PlusIcon size={13} /> Add trait category
            </button>
          </div>
          <p className="m-0 font-sans text-[11.5px] leading-[16px] text-[#8d8d8d]">
            Name categories however you like. Each image becomes a trait named after its file, which you can rename next.
            Layers stay in this browser tab. Only the finished NFT images are stored, when you launch.
          </p>
        </section>
      ) : null}

      {step === 3 ? (
        <section className={`${CARD} grid gap-[12px]`}>
          <Heading title="Manage traits" text="Rename, remove or check each trait. Weights are set on the next step." />
          {categories.map((c) => (
            <div key={c.id} className="grid gap-[6px]">
              <h3 className="m-0 font-sans text-[14px] font-semibold text-white">{c.name}</h3>
              {c.traits.map((t) => (
                <div key={t.id} className="flex items-center gap-[10px] rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[6px]">
                  <img src={t.art} alt="" className="h-[40px] w-[40px] shrink-0 rounded-[6px] bg-[#151517] object-contain" />
                  <input
                    className="h-[36px] min-w-0 flex-1 rounded-[6px] border border-[#2a2b30] bg-transparent px-[10px] font-sans text-[13.5px] text-white outline-none focus:border-sun/70"
                    value={t.name}
                    aria-label={`Name of a ${c.name} trait`}
                    onChange={(e) =>
                      updateCategory(c.id, (x) => ({ ...x, traits: x.traits.map((y) => (y.id === t.id ? { ...y, name: e.target.value.slice(0, 40) } : y)) }))
                    }
                  />
                  <SmallButton label={`Delete ${t.name}`} onClick={() => updateCategory(c.id, (x) => ({ ...x, traits: x.traits.filter((y) => y.id !== t.id) }))}>
                    <TrashIcon size={13} />
                  </SmallButton>
                </div>
              ))}
            </div>
          ))}
        </section>
      ) : null}

      {step === 4 ? (
        <section className={`${CARD} grid gap-[12px]`}>
          <Heading title="Rarity" text={`How often each trait appears across ${Number.isFinite(supplyN) ? supplyN.toLocaleString('en-US') : '-'} NFTs.`} />
          <div className="grid grid-cols-2 gap-[6px] rounded-[10px] border border-[#23242a] p-[4px]" role="radiogroup" aria-label="Distribution">
            {(['equal', 'weighted'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={`h-[38px] rounded-[7px] font-sans text-[13px] ${mode === m ? 'bg-sun-wash font-semibold text-sun' : 'text-[#cfcfcf]'}`}
              >
                {m === 'equal' ? 'Equal distribution' : 'Weighted distribution'}
              </button>
            ))}
          </div>
          {layers.map((l) => (
            <div key={l.id} className="grid gap-[4px]">
              <h3 className="m-0 font-sans text-[14px] font-semibold text-white">{l.name}</h3>
              <div className="grid grid-cols-[minmax(0,1fr)_88px_70px] gap-x-[8px] gap-y-[4px] font-sans text-[12.5px]">
                <span className="text-[#8d8d8d]">Trait</span>
                <span className="text-right text-[#8d8d8d]">Weight</span>
                <span className="text-right text-[#8d8d8d]">Expected</span>
                {expectedCounts(l, Number.isFinite(supplyN) ? supplyN : 0).map(({ option, percent, expected }) => (
                  <Fragment key={option.id}>
                    <span className="truncate self-center text-white">{option.name}</span>
                    {mode === 'weighted' ? (
                      <label className="flex items-center justify-end gap-[4px]">
                        <input
                          className="h-[32px] w-[60px] rounded-[6px] border border-[#2a2b30] bg-[#0b0b0c] px-[6px] text-right text-white outline-none focus:border-sun/70"
                          inputMode="decimal"
                          aria-label={`${option.name} weight`}
                          value={String(categories.find((c) => c.id === l.id)?.traits.find((t) => t.id === option.id)?.weight ?? 0)}
                          onChange={(e) => {
                            const value = Math.max(0, Math.min(1000, Number(e.target.value.replace(/[^0-9.]/g, '')) || 0));
                            updateCategory(l.id, (x) => ({ ...x, traits: x.traits.map((y) => (y.id === option.id ? { ...y, weight: value } : y)) }));
                          }}
                        />
                      </label>
                    ) : (
                      <span className="self-center text-right text-[#cfcfcf]">{percent.toFixed(1)}%</span>
                    )}
                    <span className="self-center text-right text-[#cfcfcf]">
                      {mode === 'weighted' ? `${percent.toFixed(1)}% · ` : ''}≈ {expected.toLocaleString('en-US')}
                    </span>
                  </Fragment>
                ))}
              </div>
            </div>
          ))}
          <p className="m-0 font-sans text-[11.5px] leading-[16px] text-[#8d8d8d]">
            Weights are relative inside each category, so 60, 25, 10 and 5 read as percentages. Expected counts are estimates:
            each NFT is drawn by weight, so the final numbers land close to them, not exactly on them.
          </p>

          <div className="rounded-[10px] border border-[#23242a]">
            <button type="button" onClick={() => setRulesOpen((o) => !o)} aria-expanded={rulesOpen} className="flex h-[44px] w-full items-center justify-between px-[12px] font-sans text-[13.5px] text-white">
              Trait rules (advanced, optional){rules.length ? ` · ${rules.length}` : ''}
              <ChevronDownIcon size={14} className={rulesOpen ? 'rotate-180' : ''} />
            </button>
            {rulesOpen ? (
              <RulesEditor layers={layers} rules={rules} onChange={setRules} />
            ) : null}
          </div>
          <p className={`m-0 font-sans text-[12.5px] ${combos.atLeast || combos.count >= supplyN ? 'text-[#2fd27a]' : 'text-[#e0b070]'}`}>
            {combos.atLeast
              ? `More than ${combos.count.toLocaleString('en-US')} unique combinations.`
              : combos.count >= supplyN
                ? `${combos.count.toLocaleString('en-US')} unique combinations, enough for ${supplyN.toLocaleString('en-US')} NFTs.`
                : `Your current traits can generate only ${combos.count.toLocaleString('en-US')} unique combinations. Add more traits or lower the supply to make ${supplyN.toLocaleString('en-US')} unique NFTs.`}
          </p>
        </section>
      ) : null}

      {step === 5 && generation ? (
        <section className={`${CARD} grid gap-[12px]`}>
          <Heading title="Collection preview" text={`A sample of ${Math.min(SAMPLE, generation.tokens.length)} NFTs from the full run. Tap one to see its traits.`} />
          <div className="grid grid-cols-2 gap-[8px] sm:grid-cols-3 lg:grid-cols-4">
            {generation.tokens.slice(0, SAMPLE).map((t) => (
              <button key={t.tokenId} type="button" onClick={() => setPicked(t)} className={`overflow-hidden rounded-[10px] border text-left ${picked?.tokenId === t.tokenId ? 'border-sun' : 'border-[#23242a]'}`}>
                <Stack layers={art(t)} />
                <span className="block bg-[#0b0b0c] px-[8px] py-[6px] font-sans text-[12.5px] text-white">{tokenLabel(t.tokenId, supplyN)}</span>
              </button>
            ))}
          </div>
          {picked ? (
            <div className="rounded-[10px] border border-[#23242a] bg-[#0b0b0c] p-[12px] font-sans text-[13px]">
              <p className="m-0 font-semibold text-white">{tokenLabel(picked.tokenId, supplyN)}</p>
              {art(picked).map((t, i) => (
                <p key={t.id} className="m-0 mt-[3px] text-[#cfcfcf]">
                  {categories[i]?.name}: <span className="text-white">{t.name}</span>
                </p>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-[8px]">
            <button type="button" onClick={() => { setSeed(Math.floor(Math.random() * 2 ** 31)); setPicked(null); }} className="h-[40px] rounded-[8px] border border-[#3a3b40] px-[14px] font-sans text-[13px] text-white">
              Regenerate
            </button>
            <button type="button" onClick={() => go(3)} className="h-[40px] rounded-[8px] border border-[#3a3b40] px-[14px] font-sans text-[13px] text-white">
              Edit traits
            </button>
          </div>
          <Validation checks={checks} />
        </section>
      ) : null}

      {step === 6 && generation ? (
        <section className={`${CARD} grid gap-[12px]`}>
          <Heading title="Review collection" text="What Flizy generated from your layers." />
          <dl className="m-0 grid grid-cols-2 gap-[10px] sm:grid-cols-4">
            <Stat label="Collection" value={name.trim()} />
            <Stat label="Supply" value={supplyN.toLocaleString('en-US')} />
            <Stat label="Royalty" value={`${Number(royalty)}%`} />
            <Stat label="Creator" value={creator.trim() || '-'} />
            <Stat label="NFTs generated" value={generation.tokens.length.toLocaleString('en-US')} />
            <Stat label="Metadata" value={generation.tokens.length.toLocaleString('en-US')} />
            <Stat label="Trait categories" value={String(categories.length)} />
            <Stat label="Generation" value="Layer-generated" />
          </dl>
          <Validation checks={checks} />
          <details className="rounded-[10px] border border-[#23242a] p-[10px] font-sans text-[12.5px] text-[#cfcfcf]">
            <summary className="cursor-pointer text-white">Metadata for {tokenLabel(1, supplyN)} (advanced)</summary>
            <pre className="mt-[8px] overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11.5px] text-[#d9d9d9]">
              {JSON.stringify(tokenMetadata({ name: name.trim(), description: description.trim() }, layers, generation.tokens[0], 'Set when the images are stored'), null, 2)}
            </pre>
          </details>
          <GeneratedLaunch
            runKey={runKey}
            stored={stored}
            onStored={setStored}
            name={name.trim()}
            symbol={symbol.trim()}
            description={description.trim()}
            supply={supplyN}
            royaltyBps={Math.round(Number(royalty) * 100)}
            tokens={generation.tokens}
            layersOf={(t) => art(t).map((x) => x.art)}
            attributesOf={(t) => tokenMetadata({ name: '', description: '' }, layers, t, '').attributes}
            canLaunch={checks.every((c) => c.ok) && generation.tokens.length === supplyN}
          />
        </section>
      ) : null}

      {error ? (
        <p className="m-0 rounded-[8px] border border-[#5a3f1a] bg-[#1a130a] px-[12px] py-[8px] font-sans text-[12.5px] text-[#e0b070]" role="alert">
          {error}
        </p>
      ) : null}

      {step < 6 ? (
        <div className="flex gap-[10px]">
          {step > 1 ? (
            <button type="button" onClick={() => go(step - 1)} className="h-[46px] w-[120px] rounded-[8px] border border-[#3a3b40] font-sans text-[14px] text-white">
              Back
            </button>
          ) : null}
          <button type="button" onClick={() => go(step + 1)} className="btn-sun h-[46px] flex-1 rounded-[8px] font-sans text-[14px]">
            Continue
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RulesEditor({ layers, rules, onChange }: { layers: TraitLayer[]; rules: TraitRule[]; onChange: (rules: TraitRule[]) => void }) {
  const options = layers.flatMap((l) => l.options.map((o) => ({ value: `${l.id}:${o.id}`, label: `${l.name}: ${o.name}`, layer: l.id, option: o.id })));
  const [when, setWhen] = useState('');
  const [kind, setKind] = useState<'requires' | 'excludes'>('excludes');
  const [then, setThen] = useState('');
  const find = (v: string) => options.find((o) => o.value === v);
  const label = (r: TraitRule) => {
    const a = find(`${r.when.layer}:${r.when.option}`)?.label ?? '?';
    const b = find(`${r.then.layer}:${r.then.option}`)?.label ?? '?';
    return r.kind === 'requires' ? `${a} only appears with ${b}` : `${a} never appears with ${b}`;
  };
  const a = find(when);
  const b = find(then);
  const valid = a && b && a.layer !== b.layer;
  const select = 'h-[38px] min-w-0 rounded-[6px] border border-[#2a2b30] bg-[#0b0b0c] px-[8px] font-sans text-[12.5px] text-white [color-scheme:dark]';
  return (
    <div className="grid gap-[8px] border-t border-[#23242a] p-[12px]">
      {rules.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-[8px] font-sans text-[12.5px] text-white">
          <span>{label(r)}</span>
          <SmallButton label="Remove rule" onClick={() => onChange(rules.filter((x) => x.id !== r.id))}>
            <TrashIcon size={13} />
          </SmallButton>
        </div>
      ))}
      <div className="grid gap-[6px] sm:grid-cols-[1fr_auto_1fr_auto]">
        <select className={select} value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Trait">
          <option value="">Pick a trait</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className={select} value={kind} onChange={(e) => setKind(e.target.value as 'requires' | 'excludes')} aria-label="Rule">
          <option value="excludes">never appears with</option>
          <option value="requires">only appears with</option>
        </select>
        <select className={select} value={then} onChange={(e) => setThen(e.target.value)} aria-label="Other trait">
          <option value="">Pick a trait</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button
          type="button"
          disabled={!valid}
          onClick={() => {
            if (!a || !b) return;
            onChange([...rules, { id: newId('r'), kind, when: { layer: a.layer, option: a.option }, then: { layer: b.layer, option: b.option } }]);
            setWhen('');
            setThen('');
          }}
          className="h-[38px] rounded-[6px] border border-sun px-[12px] font-sans text-[12.5px] text-sun disabled:opacity-40"
        >
          + Add rule
        </button>
      </div>
      {a && b && a.layer === b.layer ? <p className="m-0 font-sans text-[11.5px] text-[#e0b070]">Pick traits from two different categories.</p> : null}
    </div>
  );
}

/** One NFT: its traits stacked in category order, first at the bottom. */
function Stack({ layers }: { layers: Trait[] }) {
  return (
    <div className="relative aspect-square w-full bg-[#151517]">
      {layers.map((t) => (
        <img key={t.id} src={t.art} alt="" className="absolute inset-0 h-full w-full object-contain" />
      ))}
    </div>
  );
}

function Validation({ checks }: { checks: Array<{ ok: boolean; label: string }> }) {
  return (
    <ul className="m-0 grid list-none gap-[4px] p-0 font-sans text-[12.5px]" aria-label="Collection validation">
      {checks.map((c) => (
        <li key={c.label} className={`flex items-start gap-[6px] ${c.ok ? 'text-[#2fd27a]' : 'text-[#e0b070]'}`}>
          <span className="mt-[2px] shrink-0">{c.ok ? <CheckIcon size={12} strokeWidth={3} /> : '!'}</span>
          {c.label}
        </li>
      ))}
    </ul>
  );
}

function Heading({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h2 className="m-0 font-sans text-[16px] font-semibold text-white">{title}</h2>
      <p className="m-0 mt-[3px] font-sans text-[12.5px] leading-[17px] text-[#a9a9a9]">{text}</p>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-[6px]">
      <span className="font-sans text-[12px] font-medium text-[#d9d9d9]">{label}</span>
      {children}
      {hint ? <span className="font-sans text-[11px] leading-[15px] text-[#8d8d8d]">{hint}</span> : null}
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[10px]">
      <dt className="font-sans text-[11px] text-[#8d8d8d]">{label}</dt>
      <dd className="m-0 mt-[2px] truncate font-sans text-[14px] font-semibold text-white">{value}</dd>
    </div>
  );
}

function SmallButton({ label, disabled = false, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="hit-44 flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[6px] border border-[#2a2b30] text-[#cfcfcf] hover:text-white disabled:opacity-30"
    >
      {children}
    </button>
  );
}
