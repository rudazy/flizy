/**
 * An account's rewards as its owner sees them: the points balance and the
 * latest entries, for the chat command and Account > Rewards.
 *
 * One point is one cent of reward: usd_micro / 10,000. What each entry was
 * for is named in words, never with the share it was worked out from.
 *
 * Loaded by the site as well (web/app/api/account/rewards/route.ts), so it
 * requires no package.
 */

const POINT_MICRO = 10_000n;
const LATEST = 10;

/** Points from micro-USD, exact: up to 4 decimals, trailing zeros dropped. */
function pointsText(usdMicro) {
  const micro = BigInt(usdMicro ?? 0);
  const sign = micro < 0n ? '-' : '';
  const abs = micro < 0n ? -micro : micro;
  const whole = abs / POINT_MICRO;
  const frac = (abs % POINT_MICRO).toString().padStart(4, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}

/** What one entry was for, in words. */
function entryLabel(entry, feeKind, fromUsername) {
  switch (entry.kind) {
    case 'cashback':
      return feeKind === 'swap' ? 'Cashback on a swap' : 'Cashback on a payment';
    case 'referral':
      return fromUsername ? `Referral reward: @${fromUsername}` : 'Referral reward';
    case 'merchant':
      return 'Business reward';
    default:
      return 'Adjustment';
  }
}

/** What one entry was for, as a word the page can filter and draw an icon by. */
function entryKind(entry, feeKind) {
  switch (entry.kind) {
    case 'cashback':
      return feeKind === 'swap' ? 'swap' : 'payment';
    case 'referral':
      return 'referral';
    case 'merchant':
      return 'business';
    default:
      return 'adjustment';
  }
}

/**
 * The balance and the latest entries of one account. Throws on a read error.
 * @param {object} supabase service role client
 * @param {string} accountId
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ points: string, entries: Array<{ at: string, kind: string, label: string, points: string }>, more: boolean }>}
 */
async function loadRewards(supabase, accountId, { limit = LATEST } = {}) {
  const { data: balance, error: balanceErr } = await supabase.rpc('reward_balance', { p_account_id: accountId });
  if (balanceErr) throw new Error(balanceErr.message);
  const { data: rows, error } = await supabase
    .from('reward_entries')
    .select('kind, usd_micro, fee_ledger_id, from_account_id, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(limit + 1);
  if (error) throw new Error(error.message);
  const shown = (rows || []).slice(0, limit);

  const feeIds = [...new Set(shown.filter((r) => r.kind === 'cashback' && r.fee_ledger_id).map((r) => String(r.fee_ledger_id)))];
  const fromIds = [...new Set(shown.filter((r) => r.kind === 'referral' && r.from_account_id).map((r) => String(r.from_account_id)))];
  const feeKinds = new Map();
  if (feeIds.length) {
    const { data, error: feeErr } = await supabase.from('fee_ledger').select('id, kind').in('id', feeIds);
    if (feeErr) throw new Error(feeErr.message);
    for (const f of data || []) feeKinds.set(String(f.id), f.kind);
  }
  const usernames = new Map();
  if (fromIds.length) {
    const { data, error: nameErr } = await supabase.from('accounts').select('id, username').in('id', fromIds);
    if (nameErr) throw new Error(nameErr.message);
    for (const a of data || []) if (a.username) usernames.set(String(a.id), String(a.username));
  }

  return {
    points: pointsText(balance ?? 0),
    entries: shown.map((r) => ({
      at: r.created_at,
      kind: entryKind(r, feeKinds.get(String(r.fee_ledger_id))),
      label: entryLabel(r, feeKinds.get(String(r.fee_ledger_id)), usernames.get(String(r.from_account_id))),
      points: pointsText(r.usd_micro),
    })),
    more: (rows || []).length > limit,
  };
}

const TESTNET_NOTE = 'Points, not money, while Flizy is on testnet.';
const HOW_TO_EARN = 'You earn points on the fees you pay, when people you invite pay fees, and on your sales as a business.';

/** The chat reply. */
function rewardsChatText(view, siteUrl) {
  const lines = [`Your rewards: ${view.points} points`];
  if (!view.entries.length) {
    lines.push('', 'No rewards yet.', HOW_TO_EARN);
  } else {
    lines.push('', 'Latest:');
    for (const e of view.entries.slice(0, 5)) lines.push(`${e.points.startsWith('-') ? '' : '+'}${e.points} ${e.label}`);
  }
  lines.push('', TESTNET_NOTE);
  if (siteUrl) lines.push(`All of them: ${siteUrl}/dashboard/account?s=rewards`);
  return lines.join('\n');
}

module.exports = { pointsText, entryLabel, entryKind, loadRewards, rewardsChatText, TESTNET_NOTE, HOW_TO_EARN };
