import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../../../lib/apiError';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { nftContext } from '../../../../../lib/nftApi.ts';
import { mintConfig, readDrop } from '../../../../../lib/mintDrop.ts';
import {
  ALLOWLIST_BATCH_MAX,
  AllowlistFullError,
  addAllowlistRows,
  getDrop,
  listAllowlist,
  parseAllowlistInput,
  refreshAllowlistRoot,
  removeAllowlistRows,
  resolveUsernames,
  type DropRow,
} from '../../../../../lib/mintDrops.ts';
import { MintError } from '../../../../../lib/mintExecute.ts';
import { allowlistEntriesForCreator, parseRemoveKeys } from '../../../../../lib/mintInput.ts';
import { clientErrorResponse, field, intField, readJson, routeCollection } from '../../../../../lib/mintRequest.ts';

/** The creator's own Flizy-managed drop, or a refusal. Database edits only; nothing here touches the chain. */
async function creatorDrop(collectionParam: string, accountId: string): Promise<DropRow> {
  const row = await getDrop(routeCollection(collectionParam));
  if (!row) throw new MintError('This collection does not mint through Flizy.', 404);
  if (row.creator_account_id !== accountId) throw new MintError('Only the creator can see or change this allowlist.', 403);
  if (row.mode !== 'flizy') throw new MintError('This collection mints through its own contract; Flizy cannot add an allowlist to it.');
  return row;
}

/** Is the saved list the one live on chain? */
async function publishedState(row: DropRow, root: string): Promise<boolean | null> {
  const cfg = mintConfig();
  if (!cfg) return null;
  const state = await readDrop(nftContext().provider, cfg, row.collection).catch(() => null);
  if (!state?.configured || !state.config) return false;
  return state.config.merkleRoot === root.toLowerCase();
}

function counts(rows: Array<{ source: string; allowance: number }>) {
  const by = { username: 0, address: 0, csv: 0 };
  let tokens = 0;
  for (const r of rows) {
    by[r.source as keyof typeof by] += 1;
    tokens += r.allowance;
  }
  return { wallets: rows.length, tokens, bySource: by };
}

/**
 * The allowlist for the creator: each entry, its allowance and where it came
 * from. Entries added by Flizy username come back as the username only.
 */
export async function GET(_req: Request, { params }: { params: { collection: string } }) {
  const route = 'GET /api/mints/[collection]/allowlist';
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const row = await creatorDrop(params.collection, accountId);
    const rows = await listAllowlist(row.id);
    const root = row.allowlist_root ?? `0x${'0'.repeat(64)}`;
    return NextResponse.json({
      entries: allowlistEntriesForCreator(rows),
      ...counts(rows),
      root,
      published: await publishedState(row, root),
    });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(route, err), { status: 500 });
  }
}

/**
 * Add people. { text, csv?, allowance? }: Flizy usernames (@john, @john 2),
 * wallet addresses, or CSV rows (address,allowance). Usernames resolve to the
 * account's wallet now. Unknown names and bad lines are returned, not added.
 * The saved root changes; the creator publishes it to make it live.
 */
export async function POST(req: Request, { params }: { params: { collection: string } }) {
  const route = 'POST /api/mints/[collection]/allowlist';
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const row = await creatorDrop(params.collection, accountId);
    const body = await readJson(req);
    const text = String(field(body, 'text') ?? '');
    if (text.length > 200_000) throw new MintError('That list is too long for one upload.');
    const allowance = intField(field(body, 'allowance') ?? 1, 'Allowance', 1, 10_000);
    const parsed = parseAllowlistInput(text, allowance, field(body, 'csv') === true);
    if (parsed.usernames.length + parsed.addresses.length > ALLOWLIST_BATCH_MAX) {
      throw new MintError(`Add at most ${ALLOWLIST_BATCH_MAX} entries at a time.`);
    }
    const { resolved, unknown } = await resolveUsernames(parsed.usernames);
    try {
      await addAllowlistRows(row.id, [
        ...resolved.map((r) => ({ address: r.address, allowance: r.allowance, source: 'username' as const, accountId: r.accountId, username: r.username })),
        ...parsed.addresses.map((a) => ({ address: a.address, allowance: a.allowance, source: a.source })),
      ]);
    } catch (err) {
      if (err instanceof AllowlistFullError) throw new MintError(err.message);
      throw err;
    }
    const root = await refreshAllowlistRoot(row);
    const rows = await listAllowlist(row.id);
    return NextResponse.json({
      added: resolved.length + parsed.addresses.length,
      unknownUsernames: unknown,
      errors: parsed.errors.slice(0, 50),
      ...counts(rows),
      root,
      published: await publishedState(row, root),
    });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(route, err), { status: 500 });
  }
}

/** Remove entries: { keys: ["@name" | "0x..."] }, as GET lists them. */
export async function DELETE(req: Request, { params }: { params: { collection: string } }) {
  const route = 'DELETE /api/mints/[collection]/allowlist';
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const row = await creatorDrop(params.collection, accountId);
    const body = await readJson(req);
    await removeAllowlistRows(row.id, parseRemoveKeys(field(body, 'keys')));
    const root = await refreshAllowlistRoot(row);
    const rows = await listAllowlist(row.id);
    return NextResponse.json({ ...counts(rows), root, published: await publishedState(row, root) });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(route, err), { status: 500 });
  }
}
