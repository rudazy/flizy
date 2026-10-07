/**
 * Generate with AI: Claude plans a collection's trait structure from the
 * creator's description, and an image model draws one layer per trait. The
 * creator's own layer pipeline does the rest (weights, rules, unique
 * combinations, metadata), so an AI collection is a layer collection.
 *
 * Off until keys are set: ANTHROPIC_API_KEY for the plan, AI_IMAGE_API_KEY for
 * the layers. The image service is OpenAI's image API; AI_IMAGE_MODEL picks
 * the model. Every plan passes checkPlan (web/lib/aiPlan.ts) before the screen sees it.
 */

import Anthropic from '@anthropic-ai/sdk';
import { MAX_CATEGORIES, MAX_TRAITS, RARITIES, checkPlan, type CollectionPlan } from './aiPlan.ts';

export type PlanRequest = {
  prompt: string;
  size: number;
  style: string;
  include: string[];
  custom: string;
};

export function planReady(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

export function imagesReady(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.AI_IMAGE_API_KEY?.trim());
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'symbol', 'description', 'categories'],
  properties: {
    name: { type: 'string' },
    symbol: { type: 'string' },
    description: { type: 'string' },
    categories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'traits'],
        properties: {
          name: { type: 'string' },
          traits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'rarity', 'prompt'],
              properties: {
                name: { type: 'string' },
                rarity: { type: 'string', enum: [...RARITIES] },
                prompt: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;

const SYSTEM = `You design layered NFT collections. Given a creator's description, return the collection's trait structure as JSON.

Each category is one image layer, stacked in the order you list them: the first is the background, then the character, then things worn or held on top. Every trait in a category is one interchangeable layer image drawn on the same canvas, so a trait prompt describes only that layer, centred, in the collection's art style, with the same framing as its siblings.

Keep names short and plain: letters, numbers and spaces. Give each category between 2 and ${MAX_TRAITS} traits and use at most ${MAX_CATEGORIES} categories. Choose rarities so most traits are common or uncommon and only a few are epic or legendary. Make sure the categories multiply to at least the collection size so every NFT can be unique.`;

/** Claude's plan for the request. Throws with a message the creator can read. */
export async function planCollection(req: PlanRequest, client: Anthropic = new Anthropic()): Promise<CollectionPlan> {
  const model = process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-5-5';
  const user = [
    `Description: ${req.prompt}`,
    `Collection size: ${req.size}`,
    `Art style: ${req.style}`,
    req.include.length ? `Include categories for: ${req.include.join(', ')}` : '',
    req.custom ? `Creator's extra instructions: ${req.custom}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') throw new Error('The AI declined that description. Try describing it differently.');
  if (response.stop_reason === 'max_tokens') throw new Error('The plan was too long. Ask for a smaller collection.');
  const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The plan came back malformed. Try again.');
  }
  return checkPlan(parsed);
}

export type ImageFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * One trait layer as a PNG data URL. Layers above the background come back
 * with a transparent background so they stack.
 */
export async function drawTraitLayer(
  args: { style: string; category: string; trait: string; prompt: string; background: boolean },
  env: Record<string, string | undefined> = process.env,
  fetcher: ImageFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(120_000) })
): Promise<string> {
  const key = env.AI_IMAGE_API_KEY?.trim();
  if (!key) throw new Error('AI images are not set up yet.');
  const prompt = [
    `${args.style} NFT art layer. Category: ${args.category}. Trait: ${args.trait}.`,
    args.prompt,
    args.background
      ? 'Fill the whole square canvas. No characters, no text.'
      : 'Only this element, centred, on a fully transparent background, framed to stack with the other layers of the same collection. No text.',
  ].join(' ');
  const res = await fetcher('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.AI_IMAGE_MODEL?.trim() || 'gpt-image-1',
      prompt,
      size: '1024x1024',
      n: 1,
      background: args.background ? 'opaque' : 'transparent',
      output_format: 'png',
    }),
  });
  if (!res.ok) throw new Error(`The image service refused that trait (${res.status}).`);
  const body = (await res.json().catch(() => null)) as { data?: Array<{ b64_json?: unknown }> } | null;
  const b64 = body?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length > 4_000_000) {
    throw new Error('The image service returned no image.');
  }
  return `data:image/png;base64,${b64}`;
}
