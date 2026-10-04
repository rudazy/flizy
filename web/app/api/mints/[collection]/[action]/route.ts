import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../../../lib/apiError';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { getSupabase } from '../../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { nftContext, viewerWallet } from '../../../../../lib/nftApi.ts';
import { explorerTxUrl } from '../../../../../lib/dexServer';
import {
  DROP_IFACE,
  checkSchedule,
  configTuple,
  mintConfig,
  readDrop,
  type MintConfig,
  type ScheduleInput,
} from '../../../../../lib/mintDrop.ts';
import { externalMintCall, simulateCall } from '../../../../../lib/mintExternal.ts';
import { getDrop, listAllowlist, type DropRow } from '../../../../../lib/mintDrops.ts';
import { allowlistRoot } from '../../../../../lib/mintMerkle.ts';
import { dropCard, eligibility, proofFor } from '../../../../../lib/mintView.ts';
import { MintError, runMintTx, type MintTx } from '../../../../../lib/mintExecute.ts';
import {
  clientErrorResponse,
  ethToWei,
  field,
  intField,
  readJson,
  routeCollection,
  timeField,
} from '../../../../../lib/mintRequest.ts';
import type { NftContext } from '../../../../../lib/nftApi.ts';

const ACTIONS = ['mint', 'configure', 'publish', 'pause'] as const;
type Action = (typeof ACTIONS)[number];
const SALE_TYPES = ['allowlist_public', 'public', 'allowlist'] as const;

type Viewer = { address: string; viaGator: boolean };

/** The person must be the drop's creator on Flizy and the contract owner on chain. */
async function requireCreator(ctx: NftContext, row: DropRow, accountId: string, viewer: Viewer) {
  if (row.creator_account_id !== accountId) throw new MintError('Only the creator can manage this mint.', 403);
  const owner = await new ethers.Contract(row.collection, ['function owner() view returns (address)'], ctx.provider)
    .owner()
    .then((v: string) => ethers.getAddress(v))
    .catch(() => null);
  if (owner !== viewer.address) {
    throw new MintError('This wallet no longer owns the collection contract, so it cannot change the mint.', 403);
  }
}

function requireManaged(row: DropRow, cfg: MintConfig | null): MintConfig {
  if (row.mode !== 'flizy') throw new MintError('This collection mints through its own contract; Flizy cannot change its rules.');
  if (!cfg) throw new MintError('Minting through Flizy is not live yet.', 503);
  return cfg;
}

async function planMint(ctx: NftContext, cfg: MintConfig | null, row: DropRow, viewer: Viewer, body: Record<string, unknown>): Promise<MintTx> {
  const card = await dropCard(ctx, cfg, row, null);
  const elig = await eligibility(ctx, cfg, row, card, viewer.address);
  if (!elig.now) throw new MintError(elig.reason || 'Nothing is minting for this wallet right now.');
  const quantity = intField(field(body, 'quantity') ?? 1, 'Quantity', 1, elig.now.maxQuantity);
  // The price the person reviewed must still be the price; a creator change in
  // between is refused, not charged.
  const reviewed = field(body, 'priceWei');
  if (reviewed !== undefined && String(reviewed) !== String(elig.now.priceWei ?? '0')) {
    throw new MintError('The mint price changed. Review it again.', 409);
  }
  const each = BigInt(elig.now.priceWei ?? '0');
  const label = `Mint ${quantity} ${row.name}`;

  if (elig.now.phase === 'external') {
    if (!row.external_mint_fn) throw new MintError('This contract has no supported public mint.');
    const call = externalMintCall(row.external_mint_fn, quantity, elig.now.priceWei);
    const sim = await simulateCall(ctx.provider, viewer.address, row.collection, call);
    if (!sim.ok) throw new MintError(sim.reason);
    return { calls: [{ target: row.collection, value: call.value, data: call.data }], value: call.value, label, reason: 'mint this NFT', to: row.collection };
  }

  const managed = requireManaged(row, cfg);
  let data: string;
  if (elig.now.phase === 'allowlist') {
    const proof = await proofFor(row, viewer.address);
    if (!proof) throw new MintError('This wallet is not on the allowlist.');
    data = DROP_IFACE.encodeFunctionData('mintAllowlist', [row.collection, BigInt(quantity), BigInt(proof.allowance), proof.proof]);
  } else {
    data = DROP_IFACE.encodeFunctionData('mintPublic', [row.collection, BigInt(quantity)]);
  }
  const value = each * BigInt(quantity);
  const sim = await simulateCall(ctx.provider, viewer.address, managed.drop, { data, value });
  if (!sim.ok) throw new MintError(sim.reason);
  return { calls: [{ target: managed.drop, value, data }], value, label, reason: 'mint this NFT', to: managed.drop };
}

async function planConfigure(ctx: NftContext, cfg: MintConfig | null, row: DropRow, viewer: Viewer, body: Record<string, unknown>): Promise<MintTx> {
  const managed = requireManaged(row, cfg);
  const saleType = String(field(body, 'saleType') || 'allowlist_public');
  if (!(SALE_TYPES as readonly string[]).includes(saleType)) throw new MintError('Choose how you want to sell.');
  const state = await readDrop(ctx.provider, managed, row.collection);
  const input: ScheduleInput = {
    saleType: saleType as ScheduleInput['saleType'],
    allowlistStart: timeField(field(body, 'allowlistStart'), 'Allowlist start'),
    allowlistEnd: timeField(field(body, 'allowlistEnd'), 'Allowlist end'),
    publicStart: timeField(field(body, 'publicStart'), 'Public start'),
    mintEnd: timeField(field(body, 'mintEnd'), 'Mint end'),
    allowlistPriceWei: saleType === 'public' ? '0' : ethToWei(field(body, 'allowlistPrice') ?? '0', 'allowlist price'),
    publicPriceWei: saleType === 'allowlist' ? '0' : ethToWei(field(body, 'publicPrice') ?? '0', 'public price'),
    publicLimit: saleType === 'allowlist' ? 0 : intField(field(body, 'publicLimit'), 'Per-wallet limit', 1, 10_000),
    // Payout is always the creator's own wallet: no payout address to type and get wrong.
    payout: viewer.address,
    // Configuring also publishes the saved allowlist as it stands.
    merkleRoot: saleType === 'public' ? undefined : (row.allowlist_root ?? undefined),
  };
  const checked = checkSchedule(input, Math.floor(Date.now() / 1000), !state.configured);
  if (!checked.ok) throw new MintError(checked.error);
  const data = DROP_IFACE.encodeFunctionData('configure', [row.collection, configTuple(checked.config)]);
  return { calls: [{ target: managed.drop, value: 0n, data }], value: 0n, label: `Set up mint for ${row.name}`, reason: 'change this mint', to: managed.drop };
}

async function planPublish(ctx: NftContext, cfg: MintConfig | null, row: DropRow): Promise<MintTx> {
  const managed = requireManaged(row, cfg);
  const state = await readDrop(ctx.provider, managed, row.collection);
  if (!state.configured) throw new MintError('Set up the mint schedule first; it publishes the allowlist with it.');
  // Computed from the saved rows, not written: nothing changes before the password check.
  const rows = await listAllowlist(row.id);
  const root = allowlistRoot(
    row.collection,
    rows.map((r) => ({ wallet: r.address, allowance: r.allowance }))
  );
  const data = DROP_IFACE.encodeFunctionData('setMerkleRoot', [row.collection, root]);
  return { calls: [{ target: managed.drop, value: 0n, data }], value: 0n, label: `Publish allowlist for ${row.name}`, reason: 'publish this allowlist', to: managed.drop };
}

async function planPause(ctx: NftContext, cfg: MintConfig | null, row: DropRow, body: Record<string, unknown>): Promise<MintTx> {
  const managed = requireManaged(row, cfg);
  const paused = field(body, 'paused');
  if (typeof paused !== 'boolean') throw new MintError('Say whether to pause or resume.');
  const state = await readDrop(ctx.provider, managed, row.collection);
  if (!state.configured) throw new MintError('Set up the mint schedule first.');
  const data = DROP_IFACE.encodeFunctionData('setDropPaused', [row.collection, paused]);
  return {
    calls: [{ target: managed.drop, value: 0n, data }],
    value: 0n,
    label: `${paused ? 'Pause' : 'Resume'} mint for ${row.name}`,
    reason: paused ? 'pause this mint' : 'resume this mint',
    to: managed.drop,
  };
}

/**
 * Mint, and the creator's on-chain controls. Each plan is read and checked
 * against the chain first (and a mint is simulated from the person's wallet),
 * then runMintTx takes the password, the account lock, the daily ETH limit
 * and logs it in transfers before sending.
 */
export async function POST(req: Request, { params }: { params: { collection: string; action: string } }) {
  const route = `POST /api/mints/[collection]/${ACTIONS.includes(params.action as Action) ? params.action : '[action]'}`;
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    if (!ACTIONS.includes(params.action as Action)) return NextResponse.json({ error: 'Unknown action' }, { status: 404 });
    const action = params.action as Action;
    const collection = routeCollection(params.collection);
    const body = await readJson(req);

    const row = await getDrop(collection);
    if (!row) throw new MintError('This collection does not mint through Flizy.', 404);
    const ctx = nftContext();
    const cfg = mintConfig();
    const viewer = await viewerWallet(accountId);
    if (action !== 'mint') await requireCreator(ctx, row, accountId, viewer);

    const tx =
      action === 'mint'
        ? await planMint(ctx, cfg, row, viewer, body)
        : action === 'configure'
          ? await planConfigure(ctx, cfg, row, viewer, body)
          : action === 'publish'
            ? await planPublish(ctx, cfg, row)
            : await planPause(ctx, cfg, row, body);

    const { txHash } = await runMintTx({
      supabase: getSupabase(),
      ctx,
      accountId,
      viewer,
      password: String(field(body, 'password') || ''),
      tx,
    });
    return NextResponse.json({ ok: true, txHash, explorerUrl: explorerTxUrl(ctx.chain, txHash), label: tx.label });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(route, err), { status: 500 });
  }
}
