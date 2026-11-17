/**
 * One answer to "what has happened on this account", for chat and for the site.
 *
 * These were two implementations of the same question and they disagreed. The
 * one that mattered: chat looked up transfers under **the key of the channel
 * you happened to be typing on**, while the site looked under every identity
 * the account has linked. So a user who sent from WhatsApp and then typed
 * `history` on Telegram was shown a short list with no hint anything was
 * missing. They also disagreed on which incoming claims counted and on how many
 * rows each side considered before truncating, so two people comparing screens
 * could reasonably see different histories of the same account.
 *
 * This module owns the parts that must agree — which rows exist, in what order,
 * and how many. It deliberately does **not** own presentation: a chat line and a
 * table row with a status badge are different objects, and forcing one shape on
 * both is what makes shared code hurt. Each caller gets the raw row back and
 * formats it its own way.
 *
 * **Importable by the web.** Takes its Supabase client as an argument and
 * imports only `./channelKey`, which has no dependencies at all. Nothing here
 * may reach `./supabase`, `./identity` or anything else that touches the bot's
 * singleton — that is the constraint that lets `web/app/api/history/route.ts`
 * require this file directly instead of growing a third copy.
 */

const { identityTransferKey } = require('./channelKey');
// web/app/api/history loads this file, and the site build resolves packages
// from web/node_modules only: nothing here may require a package (not even
// ethers) or a lib/ module that does. test/businessHistory.test.js checks.
const { listedBySymbol } = require('./listedTokens');

/** Columns the site and chat both read. */
const TRANSFER_SELECT_FULL =
  'id, account_id, amount_eth, to_address, status, tx_hash, created_at, phone, chain_id, kind, asset, token_address, counterparty_label, direction, amount_secondary, asset_secondary, note, venue';

/** Older deployments predate the newer columns; the query retries with these. */
const TRANSFER_SELECT_CORE =
  'id, account_id, amount_eth, to_address, status, tx_hash, created_at, phone, chain_id, kind';

const CLAIM_SELECT =
  'id, from_account_id, to_account_id, to_wa_hint, to_channel, to_external_id, to_display_handle, to_email, amount_eth, asset, token_address, nft_token_id, status, hold_tx_hash, refund_tx_hash, claim_tx_hash, expires_at, created_at, claimed_at';

/** How many rows each source contributes before the merge truncates. */
const LIMITS = Object.freeze({
  byAccount: 40,
  byKey: 20,
  keys: 8,
  claims: 30,
  result: 30,
});

/**
 * Every `transfers.phone` key this account's rows could have been written under.
 *
 * The bug this fixes: chat passed one key. An account linked to WhatsApp and
 * Telegram has rows under both, and which one you are typing on is not a reason
 * to hide the other.
 *
 * @param {object} supabase
 * @param {string} accountId
 * @param {string|null} extraKey key for a chat with no linked account yet
 * @returns {Promise<string[]>}
 */
async function transferKeysForAccount(supabase, accountId, extraKey) {
  const keys = new Set();
  if (extraKey) keys.add(String(extraKey));

  if (accountId) {
    const { data } = await supabase
      .from('channel_identities')
      .select('channel, external_id')
      .eq('account_id', accountId);
    for (const row of data || []) {
      if (!row.external_id) continue;
      try {
        keys.add(identityTransferKey(row.channel, row.external_id));
      } catch {
        // Unknown channel: skip rather than guess a key that could collide with
        // somebody else's. identityTransferKey throws for exactly that reason.
      }
    }
  }

  return Array.from(keys);
}

/** @param {object} supabase */
/**
 * Put a name on every payment that came in.
 *
 * Neither field already on the row will do. `counterparty_label` is who the
 * money went TO, so on a received row it names the reader; `phone` is the
 * sender's own number, and showing one person's number to another because they
 * were paid by them is not a thing this should do.
 *
 * One query for the whole page rather than one per row.
 */
async function nameSenders(supabase, items) {
  const ids = [
    ...new Set(
      items
        .filter((i) => i.received && i.row?.account_id)
        .map((i) => String(i.row.account_id))
    ),
  ];
  if (!ids.length) return;

  const { data, error } = await supabase.from('accounts').select('id, username').in('id', ids);
  if (error) return;

  const byId = new Map((data || []).map((a) => [String(a.id), a.username]));
  for (const item of items) {
    if (!item.received) continue;
    const username = byId.get(String(item.row?.account_id || ''));
    item.fromLabel = username ? `@${username}` : null;
  }
}

/** Whole-token text of raw units, as people write it: "10", "0.0495". */
function unitsText(units, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const frac = units % base;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

/** Raw units of a plain decimal amount, or null when it does not read as one in these decimals. */
function textUnits(text, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m || (m[2] || '').length > decimals) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] || '').padEnd(decimals, '0') || '0');
}

/** Decimals of an asset a merchant fee is charged in. */
function feeAssetDecimals(asset) {
  const upper = String(asset || 'ETH').toUpperCase();
  if (upper === 'ETH') return 18;
  const listed = listedBySymbol(upper);
  return listed ? Number(listed.decimals) : 18;
}

/**
 * On a payment a business received, the merchant fee Flizy kept
 * (lib/engine/sendFee.js, web/lib/payFee.ts): the payer's row is the price,
 * and what arrived is the price less the fee. Sets item.businessFee =
 * { kept, arrived, gross, asset } in whole-token text. A waived fee kept
 * nothing. One query for the whole page; a failed read leaves the rows as
 * they were.
 */
async function attachBusinessFees(supabase, items) {
  const received = items.filter((i) => i.source === 'transfer' && i.received && i.row?.id);
  if (!received.length) return;
  const { data, error } = await supabase
    .from('fee_ledger')
    .select('source_id, fee_units, asset, state')
    .eq('source_kind', 'transfer')
    .eq('kind', 'merchant')
    .in('source_id', received.map((i) => String(i.row.id)));
  if (error) {
    console.warn('[history] business fees not read:', String(error.message || '').slice(0, 120));
    return;
  }
  const bySource = new Map((data || []).filter((r) => r.state !== 'waived').map((r) => [String(r.source_id), r]));
  for (const item of received) {
    const fee = bySource.get(String(item.row.id));
    if (!fee) continue;
    const d = feeAssetDecimals(fee.asset);
    const gross = textUnits(item.row.amount_eth, d);
    if (gross === null) continue;
    const kept = BigInt(fee.fee_units);
    if (kept > gross) continue;
    item.businessFee = { kept: unitsText(kept, d), arrived: unitsText(gross - kept, d), gross: unitsText(gross, d), asset: String(fee.asset) };
  }
}

async function loadTransfers(supabase, accountId, keys, select, walletAddress = null) {
  const rows = new Map();

  // Rows addressed to this wallet: the third way in, and the only one that
  // finds money somebody else sent you. Every transfers row is written by the
  // sender and keyed to the sender, so without this a direct payment was
  // invisible to the person who received it.
  //
  // Deliberately not a second row for the receiver: one payment, one record,
  // read from whichever end is asking.
  if (walletAddress) {
    const byDest = await supabase
      .from('transfers')
      .select(select)
      .ilike('to_address', walletAddress)
      .order('created_at', { ascending: false })
      .limit(LIMITS.byAccount);
    if (!byDest.error) {
      for (const r of byDest.data || []) rows.set(String(r.id), r);
    }
  }

  if (accountId) {
    const byAccount = await supabase
      .from('transfers')
      .select(select)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(LIMITS.byAccount);
    if (byAccount.error) return { rows: [], error: byAccount.error };
    for (const r of byAccount.data || []) rows.set(String(r.id), r);
  }

  // One query per key rather than .in(): WhatsApp LIDs carry characters that
  // have bitten the .in() encoding before.
  for (const key of keys.slice(0, LIMITS.keys)) {
    const byKey = await supabase
      .from('transfers')
      .select(select)
      .eq('phone', key)
      .order('created_at', { ascending: false })
      .limit(LIMITS.byKey);
    if (byKey.error) continue;
    for (const r of byKey.data || []) rows.set(String(r.id), r);
  }

  return { rows: Array.from(rows.values()), error: null };
}

/**
 * Settled activity: transfers and claims, merged, newest first.
 *
 * Claims are returned whatever their status. Filtering them is a presentation
 * decision and chat used to make it silently — it hid every incoming claim that
 * was not yet claimed, which is the one row a user most wants to see.
 *
 * @param {object} supabase
 * @param {string|null} accountId
 * @param {{ transferKey?: string|null, limit?: number }} [opts]
 * @returns {Promise<{ items: Array<{ source: 'transfer'|'claim', row: object, createdAt: string, received?: boolean,
 *   fromLabel?: string|null, businessFee?: { kept: string, arrived: string, gross: string, asset: string } }>, degraded: boolean }>}
 *   `degraded` says the newer transfer columns were unavailable, so a caller
 *   can avoid promising fields the rows do not carry.
 */
async function loadSettledHistory(supabase, accountId, opts = {}) {
  const limit = opts.limit || LIMITS.result;
  const keys = await transferKeysForAccount(supabase, accountId, opts.transferKey || null);
  const wallet = opts.walletAddress || null;

  let degraded = false;
  let loaded = await loadTransfers(supabase, accountId, keys, TRANSFER_SELECT_FULL, wallet);
  if (loaded.error) {
    degraded = true;
    loaded = await loadTransfers(supabase, accountId, keys, TRANSFER_SELECT_CORE, wallet);
  }

  // `direction` on the row is always 'out': it is written by the sender and
  // says what the sender did. Whether a payment was received is a fact about
  // who is asking, so it is decided here, once, for every reader.
  const mine = wallet ? String(wallet).toLowerCase() : null;
  const items = loaded.rows.map((row) => ({
    source: 'transfer',
    row,
    received: Boolean(mine && String(row.to_address || '').toLowerCase() === mine),
    createdAt: String(row.created_at),
  }));

  if (accountId) {
    const claims = new Map();
    for (const column of ['from_account_id', 'to_account_id']) {
      const res = await supabase
        .from('claims')
        .select(CLAIM_SELECT)
        .eq(column, accountId)
        .order('created_at', { ascending: false })
        .limit(LIMITS.claims);
      if (res.error) continue;
      for (const c of res.data || []) claims.set(String(c.id), c);
    }
    for (const row of claims.values()) {
      items.push({
        source: 'claim',
        row,
        createdAt: String(row.claimed_at || row.created_at),
      });
    }
  }

  await nameSenders(supabase, items);
  await attachBusinessFees(supabase, items);

  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return { items: items.slice(0, limit), degraded };
}

module.exports = {
  // LIMITS is exported for the tests: the cap is behaviour worth asserting
  // against rather than restating. The column lists stay internal.
  LIMITS,
  transferKeysForAccount,
  loadSettledHistory,
  attachBusinessFees,
};
