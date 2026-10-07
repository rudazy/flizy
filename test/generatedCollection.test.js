/**
 * Generated collections: the $2 fee in test ETH, the paid usage quota, IPFS
 * storage, the AI plan and layer calls, and the routes' gates.
 *
 * Run: node --test test/generatedCollection.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let fee;
let storage;
let plan;
let ai;
before(async () => {
  fee = await import('../web/lib/generationFee.ts');
  storage = await import('../web/lib/collectionStorage.ts');
  plan = await import('../web/lib/aiPlan.ts');
  ai = await import('../web/lib/aiCollection.ts');
});

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1');
const dataUrl = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`;

describe('generation fee', () => {
  it('is $2 in ETH at the given rate, rounded up to a microether', () => {
    assert.equal(fee.feeWeiFor(4000), 500_000_000_000_000n);
    // 2 / 3000 = 0.000666.. ETH, up to 0.000667.
    assert.equal(fee.feeWeiFor(3000), 667_000_000_000_000n);
    assert.equal(fee.feeWeiFor(2500, 5), 2_000_000_000_000_000n);
  });

  it('quotes nothing without a usable rate', () => {
    for (const bad of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(fee.feeWeiFor(bad), null);
  });

  it('labels the payment and reads the covered supply back', () => {
    const label = fee.feeLabel('Cyber Frogs', 5000);
    assert.equal(label, 'Collection generation fee: Cyber Frogs (5000 NFTs)');
    assert.equal(fee.supplyFromLabel(label), 5000);
    assert.equal(fee.supplyFromLabel('Create collection Cyber Frogs (5000 NFTs)'), null);
    assert.equal(fee.supplyFromLabel('Collection generation fee: x'), null);
  });

  it('gives each window a quota and counts plans per UTC day', () => {
    assert.equal(fee.usageQuota('pin_image', 1000), 1110);
    assert.equal(fee.usageQuota('pin_metadata', 1000), 3);
    assert.equal(fee.usageQuota('ai_image', 1), 120);
    assert.equal(fee.usageQuota('ai_plan', 0), 10);
    assert.equal(fee.planWindow(Date.UTC(2026, 9, 7, 23, 59)), '2026-10-07T00:00:00.000Z');
  });

  it('finds the open window from the confirmed payment row', async () => {
    const now = Date.UTC(2026, 9, 7, 12);
    const calls = [];
    const builder = {
      select: (...a) => (calls.push(['select', ...a]), builder),
      eq: (...a) => (calls.push(['eq', ...a]), builder),
      like: (...a) => (calls.push(['like', ...a]), builder),
      gte: (...a) => (calls.push(['gte', ...a]), builder),
      order: () => builder,
      limit: async () => ({ data: [{ created_at: '2026-10-07T10:00:00.000Z', counterparty_label: fee.feeLabel('Frogs', 300) }], error: null }),
    };
    const supabase = { from: (t) => (calls.push(['from', t]), builder) };
    const window = await fee.openFeeWindow(supabase, 'acc-1', now);
    assert.deepEqual(window, { paidAt: '2026-10-07T10:00:00.000Z', until: '2026-10-08T10:00:00.000Z', supply: 300 });
    assert.ok(calls.some((c) => c[0] === 'eq' && c[1] === 'status' && c[2] === 'confirmed'));
    assert.ok(calls.some((c) => c[0] === 'eq' && c[1] === 'account_id' && c[2] === 'acc-1'));
    assert.ok(calls.some((c) => c[0] === 'gte' && c[2] === '2026-10-06T12:00:00.000Z'));
  });

  it('counts usage atomically in the database and refuses when it cannot', async () => {
    let args;
    const ok = { rpc: async (name, a) => ((args = [name, a]), { data: [{ allowed: true, total: 3 }], error: null }) };
    assert.equal(await fee.takeUsage(ok, 'acc', '2026-10-07T00:00:00.000Z', 'pin_image', 3, 10), true);
    assert.deepEqual(args, ['bump_generation_usage', { p_account_id: 'acc', p_window_paid_at: '2026-10-07T00:00:00.000Z', p_kind: 'pin_image', p_amount: 3, p_max: 10 }]);
    const full = { rpc: async () => ({ data: [{ allowed: false, total: 10 }], error: null }) };
    assert.equal(await fee.takeUsage(full, 'acc', 'w', 'pin_image', 1, 10), false);
    const broken = { rpc: async () => ({ data: null, error: { message: 'down' } }) };
    await assert.rejects(fee.takeUsage(broken, 'acc', 'w', 'pin_image', 1, 10), /usage count failed/);
  });
});

describe('IPFS storage', () => {
  const env = { PINATA_JWT: 'x'.repeat(40) };
  const fetcherReturning = (body, ok = true, status = 200) => {
    const seen = [];
    const f = async (url, init) => {
      seen.push({ url, init });
      return { ok, status, json: async () => body };
    };
    return { f, seen };
  };

  it('is off without a key', () => {
    assert.equal(storage.storageReady({}), false);
    assert.equal(storage.storageReady({ PINATA_JWT: 'short' }), false);
    assert.equal(storage.storageReady(env), true);
  });

  it('pins a file and returns its ipfs link, with the key only in the header', async () => {
    const { f, seen } = fetcherReturning({ IpfsHash: CID_V0 });
    assert.equal(await storage.pinFile('image-1.png', new Uint8Array(PNG), 'image/png', env, f), `ipfs://${CID_V0}`);
    assert.equal(seen[0].url, 'https://api.pinata.cloud/pinning/pinFileToIPFS');
    assert.equal(seen[0].init.headers.Authorization, `Bearer ${env.PINATA_JWT}`);
  });

  it('pins a folder and returns a base URI with the trailing slash', async () => {
    const { f, seen } = fetcherReturning({ IpfsHash: CID_V1 });
    const base = await storage.pinFolder('flizy-abc', [{ path: '1.json', text: '{}' }, { path: '2.json', text: '{}' }], env, f);
    assert.equal(base, `ipfs://${CID_V1}/`);
    const names = seen[0].init.body.getAll('file').map((b) => b.name);
    assert.deepEqual(names, ['flizy-abc/1.json', 'flizy-abc/2.json']);
    await assert.rejects(storage.pinFolder('Bad/Name', [], env, f), /bad folder/);
    await assert.rejects(storage.pinFolder('ok', [{ path: '../x.json', text: '' }], env, f), /bad file/);
  });

  it('refuses a failed upload or a reply without a content id', async () => {
    await assert.rejects(storage.pinFile('a.png', new Uint8Array(PNG), 'image/png', env, fetcherReturning({}, false, 401).f), /refused the upload \(401\)/);
    await assert.rejects(storage.pinFile('a.png', new Uint8Array(PNG), 'image/png', env, fetcherReturning({ IpfsHash: 'not-a-cid' }).f), /no content id/);
    await assert.rejects(storage.pinFile('a.png', new Uint8Array(PNG), 'image/png', {}, fetcherReturning({ IpfsHash: CID_V0 }).f), /not configured/);
  });

  it('accepts only real PNG, JPEG or WebP images under the size cap', () => {
    assert.equal(storage.decodeImageDataUrl(dataUrl('image/png', PNG)).ext, 'png');
    assert.equal(storage.decodeImageDataUrl(dataUrl('image/webp', WEBP)).mime, 'image/webp');
    // Declared PNG, but the bytes are not.
    assert.equal(storage.decodeImageDataUrl(dataUrl('image/png', WEBP)), null);
    assert.equal(storage.decodeImageDataUrl(dataUrl('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))), null);
    assert.equal(storage.decodeImageDataUrl(dataUrl('image/png', Buffer.concat([PNG, Buffer.alloc(storage.MAX_IMAGE_BYTES)]))), null);
    assert.equal(storage.decodeImageDataUrl(42), null);
  });

  it('writes standard metadata files from checked parts only', () => {
    const files = storage.metadataFiles('Frogs', 'Green.', [
      { image: `ipfs://${CID_V0}`, attributes: [{ trait_type: 'Eyes', value: 'Laser' }], extra: 'dropped' },
      { image: `ipfs://${CID_V1}`, attributes: [] },
    ], 2);
    assert.deepEqual(files.map((f) => f.path), ['1.json', '2.json']);
    assert.deepEqual(JSON.parse(files[0].text), { name: 'Frogs #1', description: 'Green.', image: `ipfs://${CID_V0}`, attributes: [{ trait_type: 'Eyes', value: 'Laser' }] });
    assert.throws(() => storage.metadataFiles('F', '', [{ image: 'https://evil.example/x.png', attributes: [] }], 5), /no stored image/);
    assert.throws(() => storage.metadataFiles('F', '', [{ image: `ipfs://${CID_V0}` }, { image: `ipfs://${CID_V0}` }], 1), /covers 1 NFTs/);
    assert.throws(() => storage.metadataFiles('F', '', [{ image: `ipfs://${CID_V0}`, attributes: [{ trait_type: 'Eyes', value: '' }] }], 1), /unusable name/);
    assert.throws(() => storage.metadataFiles('F', '', [], 1), /Add the NFTs/);
  });
});

describe('AI plan', () => {
  it('cleans the model output into a plan the screen can trust', () => {
    const p = plan.checkPlan({
      name: 'Cyber "Frogs"',
      symbol: 'cy-frog',
      description: 'Neon frogs.',
      categories: [
        { name: 'Background', traits: [{ name: 'City', rarity: 'common', prompt: 'A neon city' }, { name: 'city', rarity: 'rare', prompt: 'dup' }] },
        { name: 'Eyes', traits: [{ name: 'Laser', rarity: 'mythic', prompt: 'Red lasers' }, { name: '', rarity: 'common', prompt: 'x' }] },
        { name: 'background', traits: [{ name: 'Dup', rarity: 'common', prompt: 'dup' }] },
        { name: 'Empty', traits: [] },
      ],
    });
    assert.equal(p.name, 'Cyber Frogs');
    assert.equal(p.symbol, 'CYFROG');
    assert.deepEqual(p.categories.map((c) => c.name), ['Background', 'Eyes']);
    assert.deepEqual(p.categories[0].traits.map((t) => t.name), ['City']);
    // An unknown rarity falls back to common rather than reaching the weights.
    assert.equal(p.categories[1].traits[0].rarity, 'common');
  });

  it('caps categories and traits, and refuses a plan with nothing in it', () => {
    const many = {
      categories: Array.from({ length: 20 }, (_, i) => ({ name: `C${i}`, traits: Array.from({ length: 30 }, (_, j) => ({ name: `T${j}`, rarity: 'common', prompt: 'p' })) })),
    };
    const p = plan.checkPlan(many);
    assert.equal(p.categories.length, plan.MAX_CATEGORIES);
    assert.ok(p.categories.every((c) => c.traits.length === plan.MAX_TRAITS));
    assert.throws(() => plan.checkPlan({ categories: [] }), /without any traits/);
    assert.throws(() => plan.checkPlan(null), /without any traits/);
  });

  it('asks Claude for structured output and handles refusals and cut-offs', async () => {
    const reply = (stop_reason, text) => ({ stop_reason, content: [{ type: 'text', text }] });
    let request;
    const client = (r) => ({ messages: { create: async (req) => ((request = req), r) } });
    const good = JSON.stringify({ name: 'Frogs', symbol: 'FRG', description: '', categories: [{ name: 'Eyes', traits: [{ name: 'Laser', rarity: 'rare', prompt: 'Red' }] }] });
    const req = { prompt: 'frogs', size: 100, style: 'Pixel art', include: ['Eyes'], custom: '' };
    const p = await ai.planCollection(req, client(reply('end_turn', good)));
    assert.equal(p.categories[0].traits[0].name, 'Laser');
    assert.equal(request.output_config.format.type, 'json_schema');
    assert.match(request.messages[0].content, /Collection size: 100/);
    await assert.rejects(ai.planCollection(req, client(reply('refusal', ''))), /declined/);
    await assert.rejects(ai.planCollection(req, client(reply('max_tokens', '{'))), /too long/);
    await assert.rejects(ai.planCollection(req, client(reply('end_turn', 'not json'))), /malformed/);
  });

  it('is off without keys', () => {
    assert.equal(ai.planReady({}), false);
    assert.equal(ai.planReady({ ANTHROPIC_API_KEY: 'k' }), true);
    assert.equal(ai.imagesReady({ AI_IMAGE_API_KEY: ' ' }), false);
  });

  it('draws a layer: transparent above the background, a PNG data URL back', async () => {
    let sent;
    const f = async (url, init) => ((sent = { url, init }), { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'iVBORw0KGgo=' }] }) });
    const url = await ai.drawTraitLayer({ style: '2D', category: 'Eyes', trait: 'Laser', prompt: 'Red', background: false }, { AI_IMAGE_API_KEY: 'k' }, f);
    assert.equal(url, 'data:image/png;base64,iVBORw0KGgo=');
    const body = JSON.parse(sent.init.body);
    assert.equal(body.background, 'transparent');
    assert.equal(body.model, 'gpt-image-1');
    await ai.drawTraitLayer({ style: '2D', category: 'Background', trait: 'City', prompt: 'x', background: true }, { AI_IMAGE_API_KEY: 'k' }, f);
    assert.equal(JSON.parse(sent.init.body).background, 'opaque');
  });

  it('refuses a layer without a key, on a service error, or without an image', async () => {
    const args = { style: '2D', category: 'Eyes', trait: 'Laser', prompt: 'Red', background: false };
    await assert.rejects(ai.drawTraitLayer(args, {}), /not set up/);
    const err = async () => ({ ok: false, status: 400, json: async () => ({}) });
    await assert.rejects(ai.drawTraitLayer(args, { AI_IMAGE_API_KEY: 'k' }, err), /refused that trait \(400\)/);
    const junk = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ b64_json: '<script>' }] }) });
    await assert.rejects(ai.drawTraitLayer(args, { AI_IMAGE_API_KEY: 'k' }, junk), /no image/);
  });
});

describe('generated collection routes', () => {
  const route = (rel) => read(`web/app/api/mints/generated/${rel}/route.ts`);
  const ROUTES = ['status', 'pay', 'images', 'metadata', 'ai/plan', 'ai/image'];

  it('every route is same-origin and signed-in only', () => {
    for (const r of ROUTES) assert.match(route(r), /await generationCaller\(req\)/, r);
  });

  it('nothing that costs money runs before the fee window and quota', () => {
    const images = route('images');
    assert.ok(images.indexOf("spendFromWindow(") < images.indexOf('pinFile('));
    const metadata = route('metadata');
    assert.ok(metadata.indexOf("spendFromWindow(") < metadata.indexOf('pinFolder('));
    const image = route('ai/image');
    assert.ok(image.indexOf("spendFromWindow(") < image.indexOf('drawTraitLayer('));
    const aiPlan = route('ai/plan');
    assert.ok(aiPlan.indexOf("takeUsage(") < aiPlan.indexOf('planCollection('));
  });

  it('the fee is worked out on the server and paid through the gated mint path', () => {
    const pay = route('pay');
    assert.match(pay, /await feeQuote\(\)/);
    assert.match(pay, /runMintTx\(/);
    assert.match(pay, /quote\.feeWei > BigInt\(quotedRaw\)/);
    assert.match(pay, /feeRecipient\(ctx\.provider, cfg\.drop\)/);
  });

  it('a second payment is refused under the account lock, not only before it', () => {
    assert.match(route('pay'), /underLock: refuseIfPaid/);
    const exec = read('web/lib/mintExecute.ts');
    const lock = exec.indexOf('tryAccountTxLock(supabase');
    const check = exec.indexOf('await args.underLock()');
    assert.ok(lock > 0 && check > lock && check < exec.indexOf("from('transfers')"));
  });

  it('a collection is created with metadata only when a base URI is given and the factory supports it', () => {
    const create = read('web/app/api/mints/collections/route.ts');
    assert.match(create, /baseURI\s*\?\s*FACTORY_IFACE\.encodeFunctionData\('createWithMetadata'/);
    assert.match(create, /factorySupportsMetadata\(ctx\.provider, cfg\.factory\)/);
  });

  it('the web ABI matches the contract function', () => {
    const sol = read('contracts/src/mint/FlizyCollectionFactory.sol');
    assert.match(sol, /function createWithMetadata\(\s*string memory name,\s*string memory symbol,\s*uint256 maxSupply,\s*string memory image,\s*string memory baseURI,\s*uint96 royaltyBps\s*\)/);
    assert.match(read('web/lib/mintDrop.ts'), /'function createWithMetadata\(string name, string symbol, uint256 maxSupply, string image, string baseURI, uint96 royaltyBps\) returns \(address\)'/);
  });

  it('the usage counter is atomic and closed to the public roles', () => {
    const sql = read('supabase/migrations/20261007120000_generation_usage.sql');
    assert.match(sql, /where g\.used \+ p_amount <= p_max/);
    assert.match(sql, /revoke all on function public\.bump_generation_usage\(uuid, timestamptz, text, integer, integer\) from public, anon, authenticated/);
    assert.match(sql, /enable row level security/);
  });

  it('the client screens never import the AI SDK', () => {
    for (const f of ['AiCollectionCreator.tsx', 'GeneratedLaunch.tsx', 'CollectionCreator.tsx', 'MintCreate.tsx']) {
      assert.doesNotMatch(read(`web/components/${f}`), /aiCollection|@anthropic-ai/, f);
    }
  });
});
