'use client';

import { useState, type ReactNode } from 'react';
import { ART_STYLES, MAX_CATEGORIES, MAX_TRAITS, RARITIES, RARITY_WEIGHT, type CollectionPlan, type PlanTrait, type Rarity } from '../lib/aiPlan';
import { MAX_SUPPLY } from '../lib/collectionGen';
import { newId, type Category, type CreatorStart } from './CollectionCreator';
import { FeePanel, composeImage, launchBlocker, useGenerationStatus } from './GeneratedLaunch';
import { PlusIcon, TrashIcon } from './ExploreIcons';

const INCLUDE = ['Background', 'Body', 'Clothing', 'Eyes', 'Mouth', 'Hair', 'Headwear', 'Accessories'];

const INPUT =
  'h-[44px] w-full rounded-[8px] border border-[#2a2b30] bg-[#0b0b0c] px-[12px] font-sans text-[14px] text-white outline-none focus:border-sun/70';
const AREA =
  'min-h-[84px] w-full rounded-[8px] border border-[#2a2b30] bg-[#0b0b0c] p-[12px] font-sans text-[14px] text-white outline-none focus:border-sun/70';
const CARD = 'rounded-[12px] border border-[#23242a] bg-[#0d0d0e] p-[14px]';

/** The plan as the screen edits it: every trait and category has an id, so drawn art follows it through edits. */
type EditTrait = PlanTrait & { id: string };
type EditPlan = Omit<CollectionPlan, 'categories'> & { categories: Array<{ id: string; name: string; traits: EditTrait[] }> };
/** Drawn layer art by trait id. */
type Drawn = Record<string, string>;

function withIds(plan: CollectionPlan): EditPlan {
  return {
    ...plan,
    categories: plan.categories.map((c) => ({ id: newId('c'), name: c.name, traits: c.traits.map((t) => ({ ...t, id: newId('t') })) })),
  };
}

/**
 * Generate with AI: describe a collection, let the AI plan its categories and
 * traits, edit the plan, then (after the generation fee) have every trait
 * drawn as a layer. The drawn layers open in Create with Flizy at the traits
 * step, where weights, rules, preview and launch work as for uploaded art.
 */
export function AiCollectionCreator({ onBack, onReady }: { onBack: () => void; onReady: (start: CreatorStart) => void }) {
  const { status, failed, refresh } = useGenerationStatus();
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1000');
  const [style, setStyle] = useState<string>('2D');
  const [customStyle, setCustomStyle] = useState('');
  const [include, setInclude] = useState<string[]>(['Background', 'Body', 'Eyes', 'Headwear']);
  const [custom, setCustom] = useState('');
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [drawn, setDrawn] = useState<Drawn>({});
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState('');

  const sizeN = Number(size);
  const artStyle = style === 'Custom' ? customStyle.trim() : style;
  const formOk = prompt.trim().length > 0 && Number.isInteger(sizeN) && sizeN >= 1 && sizeN <= MAX_SUPPLY && artStyle.length > 0 && artStyle.length <= 40;
  const traits = plan ? plan.categories.flatMap((c, ci) => c.traits.map((t) => ({ c, ci, t }))) : [];
  const drawnCount = traits.filter(({ t }) => drawn[t.id]).length;
  const paid = Boolean(status?.window && status.window.supply >= sizeN);
  const notReady = !status
    ? null
    : !status.aiPlan
      ? 'Generate with AI is not set up yet.'
      : !status.aiImages
        ? 'AI art is not set up yet, so a plan cannot be drawn.'
        : launchBlocker(status);

  async function makePlan() {
    if (!formOk || planning) return;
    setPlanning(true);
    setError('');
    try {
      const res = await fetch('/api/mints/generated/ai/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), size: sizeN, style: artStyle, include, custom: custom.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The AI could not plan that.');
      setPlan(withIds(data.plan as CollectionPlan));
      setDrawn({});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The AI could not plan that.');
    } finally {
      setPlanning(false);
    }
  }

  function edit(change: (p: EditPlan) => EditPlan) {
    setPlan((p) => (p ? change(structuredClone(p)) : p));
  }

  /** A new description means new art: the old drawing is dropped and the trait is drawn again. */
  function editPrompt(ci: number, id: string, value: string) {
    edit((p) => {
      const t = p.categories[ci].traits.find((x) => x.id === id);
      if (t) t.prompt = value;
      return p;
    });
    setDrawn((d) => {
      if (!d[id]) return d;
      const next = { ...d };
      delete next[id];
      return next;
    });
  }

  async function drawAll() {
    if (!plan || drawing) return;
    setDrawing(true);
    setError('');
    const pending = traits.filter(({ t }) => !drawn[t.id]);
    let failures = 0;
    // Two at a time: fast enough, and gentle on the image service's rate limit.
    const queue = [...pending];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          const res = await fetch('/api/mints/generated/ai/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ style: artStyle, category: job.c.name, trait: job.t.name, prompt: job.t.prompt, background: job.ci === 0 }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || typeof data.dataUrl !== 'string') {
            failures += 1;
            if (res.status === 402 || res.status === 429) {
              setError(typeof data.error === 'string' ? data.error : 'The fee does not cover more art.');
              queue.length = 0;
            }
            continue;
          }
          // Re-encoded small in the browser, so dozens of layers fit in memory.
          const small = await composeImage([data.dataUrl], undefined, false).catch(() => data.dataUrl as string);
          setDrawn((d) => ({ ...d, [job.t.id]: small }));
        } catch {
          failures += 1;
        }
      }
    };
    await Promise.all([worker(), worker()]);
    setDrawing(false);
    if (failures) setError((e) => e || `${failures} ${failures === 1 ? 'trait' : 'traits'} could not be drawn. Draw again to retry them.`);
  }

  function continueWithLayers() {
    if (!plan) return;
    const categories: Category[] = plan.categories.map((c) => ({
      id: c.id,
      name: c.name.trim(),
      traits: c.traits.flatMap((t) => {
        const art = drawn[t.id];
        return art ? [{ id: t.id, name: t.name.trim(), weight: RARITY_WEIGHT[t.rarity], art }] : [];
      }),
    }));
    onReady({ name: plan.name, symbol: plan.symbol, description: plan.description, supply: sizeN, categories });
  }

  return (
    <div className="grid gap-[14px]">
      <button type="button" onClick={onBack} className="hit-y-44 justify-self-start font-sans text-[12px] text-[#cfcfcf]">
        Change how you create
      </button>
      <div>
        <h2 className="m-0 font-sans text-[18px] font-bold text-white">Generate with AI</h2>
        <p className="m-0 mt-[3px] font-sans text-[12.5px] text-[#a9a9a9]">Describe your idea and let Flizy build the collection.</p>
      </div>

      {failed ? <Note>Could not load what is available. Refresh the page to try again.</Note> : null}
      {notReady ? <Note>{notReady}</Note> : null}

      <section className={`${CARD} grid gap-[12px]`}>
        <Field label="Describe your collection">
          <textarea
            className={AREA}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={1000}
            placeholder="A collection of 5,000 cyberpunk frogs with neon accessories, futuristic clothing, rare glowing eyes and city backgrounds."
          />
        </Field>
        <div className="grid gap-[12px] sm:grid-cols-2">
          <Field label="Collection size">
            <input className={INPUT} inputMode="numeric" value={size} onChange={(e) => setSize(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))} />
          </Field>
          <Field label="Art style">
            <select className={`${INPUT} [color-scheme:dark]`} value={style} onChange={(e) => setStyle(e.target.value)}>
              {ART_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </div>
        {style === 'Custom' ? (
          <Field label="Your art style">
            <input className={INPUT} value={customStyle} onChange={(e) => setCustomStyle(e.target.value)} maxLength={40} placeholder="Watercolour, flat vector..." />
          </Field>
        ) : null}
        <fieldset className="m-0 grid gap-[6px] border-0 p-0">
          <legend className="mb-[6px] font-sans text-[12px] font-medium text-[#d9d9d9]">Trait categories to include</legend>
          <div className="flex flex-wrap gap-[6px]">
            {INCLUDE.map((label) => {
              const on = include.includes(label);
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setInclude((list) => (on ? list.filter((x) => x !== label) : [...list, label]))}
                  className={`hit-y-44 h-[32px] rounded-full border px-[12px] font-sans text-[12.5px] ${on ? 'border-sun bg-sun-wash text-sun' : 'border-[#2a2b30] text-[#cfcfcf]'}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </fieldset>
        <Field label="Custom instructions (optional)">
          <textarea className={AREA} value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={500} placeholder="Keep the frogs facing forward. No weapons." />
        </Field>
        <button
          type="button"
          disabled={!formOk || planning || !status?.aiPlan}
          onClick={() => void makePlan()}
          className="btn-sun h-[46px] rounded-[8px] font-sans text-[14px] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {planning ? 'Planning your collection...' : plan ? 'Plan again' : 'Plan collection'}
        </button>
        <p className="m-0 font-sans text-[11px] leading-[16px] text-[#8d8d8d]">Planning is free. You see and edit the plan before anything is drawn or paid.</p>
      </section>

      {plan ? (
        <section className={`${CARD} grid gap-[12px]`}>
          <div>
            <h2 className="m-0 font-sans text-[16px] font-semibold text-white">Your plan</h2>
            <p className="m-0 mt-[3px] font-sans text-[12.5px] text-[#a9a9a9]">
              Edit anything before the art is drawn. Each category is one layer; the first is the background.
            </p>
          </div>
          <div className="grid gap-[12px] sm:grid-cols-2">
            <Field label="Collection name">
              <input className={INPUT} value={plan.name} maxLength={64} onChange={(e) => edit((p) => ({ ...p, name: e.target.value }))} />
            </Field>
            <Field label="Symbol">
              <input className={INPUT} value={plan.symbol} maxLength={16} onChange={(e) => edit((p) => ({ ...p, symbol: e.target.value.toUpperCase() }))} />
            </Field>
          </div>
          <Field label="Description">
            <textarea className={AREA} value={plan.description} maxLength={2000} onChange={(e) => edit((p) => ({ ...p, description: e.target.value }))} />
          </Field>
          {plan.categories.map((c, ci) => (
            <div key={c.id} className="grid gap-[6px] rounded-[10px] border border-[#23242a] bg-[#0b0b0c] p-[10px]">
              <div className="flex items-center gap-[8px]">
                <input
                  className="h-[36px] min-w-0 flex-1 rounded-[6px] border border-[#2a2b30] bg-transparent px-[10px] font-sans text-[14px] font-semibold text-white outline-none focus:border-sun/70"
                  value={c.name}
                  maxLength={40}
                  aria-label="Category name"
                  onChange={(e) => edit((p) => { p.categories[ci].name = e.target.value; return p; })}
                />
                <IconButton label={`Delete ${c.name}`} onClick={() => edit((p) => ({ ...p, categories: p.categories.filter((_, i) => i !== ci) }))}>
                  <TrashIcon size={13} />
                </IconButton>
              </div>
              {c.traits.map((t, ti) => (
                <div key={t.id} className="grid gap-[6px] rounded-[8px] border border-[#1f2025] p-[8px] sm:grid-cols-[56px_minmax(0,1fr)_120px_auto] sm:items-center">
                  {drawn[t.id] ? (
                    <img src={drawn[t.id]} alt={t.name} className="h-[56px] w-[56px] rounded-[6px] bg-[#151517] object-contain" />
                  ) : (
                    <span className="flex h-[56px] w-[56px] items-center justify-center rounded-[6px] border border-dashed border-[#2a2b30] font-sans text-[10px] text-[#8d8d8d]">Not drawn</span>
                  )}
                  <div className="grid min-w-0 gap-[4px]">
                    <input
                      className="h-[34px] rounded-[6px] border border-[#2a2b30] bg-transparent px-[8px] font-sans text-[13px] text-white outline-none focus:border-sun/70"
                      value={t.name}
                      maxLength={40}
                      aria-label={`Name of a ${c.name} trait`}
                      onChange={(e) => edit((p) => { p.categories[ci].traits[ti].name = e.target.value; return p; })}
                    />
                    <input
                      className="h-[34px] rounded-[6px] border border-[#2a2b30] bg-transparent px-[8px] font-sans text-[12px] text-[#cfcfcf] outline-none focus:border-sun/70"
                      value={t.prompt}
                      maxLength={400}
                      aria-label={`What ${t.name} looks like`}
                      onChange={(e) => editPrompt(ci, t.id, e.target.value)}
                    />
                  </div>
                  <select
                    className="h-[34px] rounded-[6px] border border-[#2a2b30] bg-[#0b0b0c] px-[8px] font-sans text-[12.5px] capitalize text-white [color-scheme:dark]"
                    value={t.rarity}
                    aria-label={`${t.name} rarity`}
                    onChange={(e) => edit((p) => { p.categories[ci].traits[ti].rarity = e.target.value as Rarity; return p; })}
                  >
                    {RARITIES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <IconButton label={`Delete ${t.name}`} onClick={() => edit((p) => { p.categories[ci].traits.splice(ti, 1); return p; })}>
                    <TrashIcon size={13} />
                  </IconButton>
                </div>
              ))}
              {c.traits.length < MAX_TRAITS ? (
                <button
                  type="button"
                  onClick={() => edit((p) => { p.categories[ci].traits.push({ id: newId('t'), name: `New ${c.name}`.slice(0, 40), rarity: 'common', prompt: '' }); return p; })}
                  className="hit-y-44 flex h-[34px] items-center justify-center gap-[6px] rounded-[8px] border border-dashed border-[#3a3b40] font-sans text-[12.5px] text-[#e6e6e6]"
                >
                  <PlusIcon size={12} /> Add trait
                </button>
              ) : null}
            </div>
          ))}
          {plan.categories.length < MAX_CATEGORIES ? (
            <button
              type="button"
              onClick={() => edit((p) => ({ ...p, categories: [...p.categories, { id: newId('c'), name: 'New category', traits: [] }] }))}
              className="hit-y-44 flex h-[38px] items-center justify-center gap-[6px] rounded-[8px] border border-dashed border-[#3a3b40] font-sans text-[13px] text-[#e6e6e6]"
            >
              <PlusIcon size={13} /> Add category
            </button>
          ) : null}

          {status && !notReady ? (
            <>
              <FeePanel status={status} name={plan.name.trim() || 'Untitled collection'} supply={sizeN} onPaid={refresh} onClosed={refresh} />
              <button
                type="button"
                disabled={!paid || drawing || drawnCount === traits.length || traits.some(({ t }) => !t.name.trim() || !t.prompt.trim())}
                onClick={() => void drawAll()}
                className="btn-sun h-[46px] rounded-[8px] font-sans text-[14px] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {drawing ? `Drawing art: ${drawnCount} of ${traits.length}` : drawnCount === traits.length ? 'Every trait is drawn' : drawnCount ?`Draw the remaining ${traits.length - drawnCount}` : `Draw ${traits.length} traits`}
              </button>
              <button
                type="button"
                disabled={drawing || drawnCount === 0}
                onClick={continueWithLayers}
                className="h-[44px] rounded-[8px] border border-[#3a3b40] font-sans text-[13.5px] text-white disabled:opacity-40"
              >
                Continue with {drawnCount} drawn {drawnCount === 1 ? 'trait' : 'traits'}
              </button>
              <p className="m-0 font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
                Next you check rarity, preview the NFTs and launch, as with your own artwork. Drawn art stays in this browser tab until you launch.
              </p>
            </>
          ) : null}
        </section>
      ) : null}

      {error ? (
        <p className="m-0 rounded-[8px] border border-[#5a3f1a] bg-[#1a130a] px-[12px] py-[8px] font-sans text-[12.5px] text-[#e0b070]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <div className="rounded-[10px] border border-[#5a3f1a] bg-[#1a130a] p-[12px] font-sans text-[12.5px] leading-[18px] text-[#e0b070]">{children}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-[6px]">
      <span className="font-sans text-[12px] font-medium text-[#d9d9d9]">{label}</span>
      {children}
    </label>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="hit-44 flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[6px] border border-[#2a2b30] text-[#cfcfcf] hover:text-white"
    >
      {children}
    </button>
  );
}
