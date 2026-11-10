/**
 * Traction metrics, weekly, from plain rows. The only place they are defined:
 * the private dashboard, its CSV and the weekly snapshot job all call
 * computeTraction, and test/traction.test.js checks every figure on a small
 * fixture with known answers. Counts and aggregates only: nothing here returns
 * an id, an address, a phone or a name.
 *
 * Definitions (TRACTION_DEFINITION_VERSION; raise it when one changes, so
 * snapshots of the old meaning stay labelled as such):
 *
 *   week           Monday 00:00 UTC to the next Monday.
 *   registered     an account with an email that is not deleted.
 *   activated      registered, email verified now, and a WhatsApp or Telegram
 *                  chat linked at some point; dated by the first link.
 *   payment        a person-to-person payment: a confirmed transfer
 *                  (kind 'transfer') from a Flizy account to another Flizy
 *                  account's wallet, or an escrow claim it made (not cancelled
 *                  by the API). Not a swap, an NFT trade, a send to one's own
 *                  wallet, or an API payout. A send to an address no Flizy
 *                  account holds is counted apart, as external.
 *   payer          an account that made a payment that week.
 *   repeat payer   a payer that week who also paid in an earlier week.
 *   repeat pair    a payer and recipient with two or more payments so far.
 *   incentive tag  organic, starter (paying the starter-pack host), system, or
 *                  untagged (rows from before tagging existed).
 *   incentivised   a payer who had received test money from the faucet or won
 *                  a task before that week ended. Being invited is not one:
 *                  invite credit goes to the inviter and is not money.
 *   qualified      an invited account that linked a chat and made three
 *                  organic payments; dated by the later of the two.
 *   referral
 *
 * Excluding test and team accounts drops every row whose payer, recipient,
 * account or platform owner is on the exclusion list.
 *
 * No imports, so node --test loads this file directly.
 */

export const TRACTION_DEFINITION_VERSION = 1;

const WEEK_MS = 7 * 24 * 3600 * 1000;

export type IncentiveTag = 'organic' | 'starter' | 'system' | 'untagged';

export type TractionInput = {
  now: number;
  accounts: Array<{ id: string; createdAt: string; hasEmail: boolean; verified: boolean; deleted: boolean; wallet: string | null }>;
  /** LINKED events for WhatsApp and Telegram. */
  links: Array<{ accountId: string; at: string }>;
  transfers: Array<{
    id: string;
    accountId: string | null;
    toAddress: string | null;
    status: string;
    kind: string | null;
    at: string;
    tag: string | null;
  }>;
  /** Transfers an API payout sent (api_transactions.transfer_id). */
  apiPayoutTransferIds: string[];
  claims: Array<{
    fromAccountId: string | null;
    /** The claiming account once claimed; otherwise null. */
    toAccountId: string | null;
    /** A stable, opaque key for who the claim is for, made on the server. */
    recipientKey: string;
    status: string;
    at: string;
    expiresAt: string | null;
    fromApi: boolean;
    tag: string | null;
  }>;
  incentives: Array<{ accountId: string; at: string; kind: 'faucet' | 'task' }>;
  invites: Array<{ invitee: string; at: string }>;
  apiRequests: Array<{ platformAccountId: string | null; at: string; status: number }>;
  apiTransactions: Array<{ platformAccountId: string | null; kind: string; state: string; at: string }>;
  /** Calling code of each account's verified phone ('' when none). */
  phones: Array<{ accountId: string; dial: string }>;
  excluded: string[];
};

export type WeekMetrics = {
  week_start: string;
  partial: boolean;
  registered_total: number;
  registered_new: number;
  activated_total: number;
  activated_new: number;
  first_time_payers: number;
  active_payers: number;
  repeat_payers: number;
  repeat_payer_rate: number | null;
  payments: number;
  payments_per_active_payer: number | null;
  repeat_pairs_total: number;
  external_payments: number;
  claims_created: number;
  claims_claimed: number;
  claims_cancelled: number;
  claims_pending: number;
  claims_expired: number;
  claim_rate: number | null;
  payments_organic: number;
  payments_incentivised: number;
  payments_untagged: number;
  payers_incentivised: number;
  payers_incentivised_repeat_rate: number | null;
  payers_not_incentivised: number;
  payers_not_incentivised_repeat_rate: number | null;
  referrals_qualified_new: number;
  referrals_qualified_total: number;
  api_requests: number;
  api_request_errors: number;
  api_platforms_active: number;
  api_payouts_created: number;
  api_payouts_confirmed: number;
  api_payouts_failed: number;
  api_payout_success_rate: number | null;
  api_payments_created: number;
  api_payments_confirmed: number;
  api_payments_expired: number;
  api_payment_success_rate: number | null;
};

export type TractionResult = {
  definitionVersion: number;
  excluded: boolean;
  weeks: WeekMetrics[];
  /** Registered accounts by the calling code of their verified phone; '' is unknown. */
  countries: Array<{ dial: string; accounts: number }>;
};

type Payment = { payer: string; recipient: string; at: number; tag: IncentiveTag };

/** Monday 00:00 UTC of the week holding t. */
export function weekStart(t: number): number {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

function ms(iso: string | null): number {
  const v = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : NaN;
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10000) / 10000 : null;
}

function tagOf(raw: string | null): IncentiveTag {
  return raw === 'organic' || raw === 'starter' || raw === 'system' ? raw : 'untagged';
}

/** Person-to-person payments, and the transfers that went to no Flizy account. */
export function paymentsFrom(input: TractionInput, drop: (accountId: string | null) => boolean): { payments: Payment[]; external: number[] } {
  const owner = new Map<string, string>();
  for (const a of input.accounts) if (a.wallet) owner.set(a.wallet.toLowerCase(), a.id);
  const payouts = new Set(input.apiPayoutTransferIds);
  const payments: Payment[] = [];
  const external: number[] = [];
  for (const t of input.transfers) {
    if (t.status !== 'confirmed' || (t.kind ?? 'transfer') !== 'transfer' || !t.accountId || payouts.has(t.id)) continue;
    const at = ms(t.at);
    if (!Number.isFinite(at)) continue;
    const to = t.toAddress ? owner.get(t.toAddress.toLowerCase()) : undefined;
    if (to === t.accountId) continue;
    if (drop(t.accountId)) continue;
    if (!to) {
      external.push(at);
      continue;
    }
    if (drop(to)) continue;
    payments.push({ payer: t.accountId, recipient: `a:${to}`, at, tag: tagOf(t.tag) });
  }
  for (const c of input.claims) {
    if (c.fromApi || !c.fromAccountId || c.status === 'cancelled' || c.status === 'expired') continue;
    const at = ms(c.at);
    if (!Number.isFinite(at) || drop(c.fromAccountId) || (c.toAccountId && drop(c.toAccountId))) continue;
    if (c.toAccountId === c.fromAccountId) continue;
    payments.push({ payer: c.fromAccountId, recipient: c.toAccountId ? `a:${c.toAccountId}` : `k:${c.recipientKey}`, at, tag: tagOf(c.tag) });
  }
  payments.sort((a, b) => a.at - b.at);
  return { payments, external };
}

export function computeTraction(input: TractionInput, opts: { exclude: boolean }): TractionResult {
  const excluded = new Set(opts.exclude ? input.excluded : []);
  const drop = (id: string | null) => Boolean(id && excluded.has(id));

  const accounts = input.accounts.filter((a) => a.hasEmail && !a.deleted && !drop(a.id));
  const firstLink = new Map<string, number>();
  for (const l of input.links) {
    const at = ms(l.at);
    if (!Number.isFinite(at)) continue;
    if (!firstLink.has(l.accountId) || at < firstLink.get(l.accountId)!) firstLink.set(l.accountId, at);
  }
  const activatedAt = new Map<string, number>();
  for (const a of accounts) if (a.verified && firstLink.has(a.id)) activatedAt.set(a.id, firstLink.get(a.id)!);

  const { payments, external } = paymentsFrom(input, drop);
  const firstPaid = new Map<string, number>();
  for (const p of payments) if (!firstPaid.has(p.payer)) firstPaid.set(p.payer, p.at);

  const incentivisedAt = new Map<string, number>();
  for (const i of input.incentives) {
    const at = ms(i.at);
    if (!Number.isFinite(at) || drop(i.accountId)) continue;
    if (!incentivisedAt.has(i.accountId) || at < incentivisedAt.get(i.accountId)!) incentivisedAt.set(i.accountId, at);
  }

  // A qualified referral: invited, linked a chat, three organic payments.
  const invited = new Set(input.invites.filter((i) => !drop(i.invitee)).map((i) => i.invitee));
  const qualifiedAt = new Map<string, number>();
  const organicCount = new Map<string, number>();
  for (const p of payments) {
    if (p.tag !== 'organic' || !invited.has(p.payer)) continue;
    const n = (organicCount.get(p.payer) ?? 0) + 1;
    organicCount.set(p.payer, n);
    if (n === 3 && firstLink.has(p.payer)) qualifiedAt.set(p.payer, Math.max(p.at, firstLink.get(p.payer)!));
  }

  const claims = input.claims.filter((c) => !c.fromApi && !drop(c.fromAccountId) && Number.isFinite(ms(c.at)));
  const apiReq = input.apiRequests.filter((r) => !drop(r.platformAccountId) && Number.isFinite(ms(r.at)));
  const apiTx = input.apiTransactions.filter((r) => !drop(r.platformAccountId) && Number.isFinite(ms(r.at)));

  const starts = [
    ...accounts.map((a) => ms(a.createdAt)),
    ...payments.map((p) => p.at),
    ...claims.map((c) => ms(c.at)),
  ].filter(Number.isFinite);
  const first = starts.length ? weekStart(Math.min(...starts)) : weekStart(input.now);
  const last = weekStart(input.now);

  const weeks: WeekMetrics[] = [];
  for (let s = first; s <= last; s += WEEK_MS) {
    const e = s + WEEK_MS;
    const inWeek = (t: number) => t >= s && t < e;
    const created = (iso: string) => ms(iso);

    const weekPayments = payments.filter((p) => inWeek(p.at));
    const payers = new Set(weekPayments.map((p) => p.payer));
    const repeat = [...payers].filter((id) => firstPaid.get(id)! < s);
    const pairCounts = new Map<string, number>();
    for (const p of payments) if (p.at < e) pairCounts.set(`${p.payer}|${p.recipient}`, (pairCounts.get(`${p.payer}|${p.recipient}`) ?? 0) + 1);

    const weekClaims = claims.filter((c) => inWeek(created(c.at)));
    const expiredClaim = (c: (typeof claims)[number]) =>
      c.status === 'expired' || ((c.status === 'pending' || c.status === 'processing') && c.expiresAt != null && ms(c.expiresAt) <= Math.min(e, input.now));
    const claimsClaimed = weekClaims.filter((c) => c.status === 'claimed').length;

    const incentivised = [...payers].filter((id) => (incentivisedAt.get(id) ?? Infinity) < e);
    const notIncentivised = [...payers].filter((id) => !((incentivisedAt.get(id) ?? Infinity) < e));
    const repeatOf = (ids: string[]) => ids.filter((id) => firstPaid.get(id)! < s).length;

    const weekReq = apiReq.filter((r) => inWeek(ms(r.at)));
    const weekTx = apiTx.filter((r) => inWeek(ms(r.at)));
    const payouts = weekTx.filter((r) => r.kind === 'payout');
    const checkouts = weekTx.filter((r) => r.kind === 'payment');
    const payoutsConfirmed = payouts.filter((r) => r.state === 'confirmed').length;
    const payoutsFailed = payouts.filter((r) => r.state === 'failed').length;
    const checkoutsConfirmed = checkouts.filter((r) => r.state === 'confirmed').length;
    const checkoutsExpired = checkouts.filter((r) => r.state === 'expired').length;

    weeks.push({
      week_start: new Date(s).toISOString().slice(0, 10),
      partial: e > input.now,
      registered_total: accounts.filter((a) => created(a.createdAt) < e).length,
      registered_new: accounts.filter((a) => inWeek(created(a.createdAt))).length,
      activated_total: [...activatedAt.values()].filter((t) => t < e).length,
      activated_new: [...activatedAt.values()].filter(inWeek).length,
      first_time_payers: [...firstPaid.values()].filter(inWeek).length,
      active_payers: payers.size,
      repeat_payers: repeat.length,
      repeat_payer_rate: ratio(repeat.length, payers.size),
      payments: weekPayments.length,
      payments_per_active_payer: payers.size ? Math.round((weekPayments.length / payers.size) * 100) / 100 : null,
      repeat_pairs_total: [...pairCounts.values()].filter((n) => n >= 2).length,
      external_payments: external.filter(inWeek).length,
      claims_created: weekClaims.length,
      claims_claimed: claimsClaimed,
      claims_cancelled: weekClaims.filter((c) => c.status === 'cancelled').length,
      claims_pending: weekClaims.filter((c) => (c.status === 'pending' || c.status === 'processing') && !expiredClaim(c)).length,
      claims_expired: weekClaims.filter(expiredClaim).length,
      claim_rate: ratio(claimsClaimed, weekClaims.length),
      payments_organic: weekPayments.filter((p) => p.tag === 'organic').length,
      payments_incentivised: weekPayments.filter((p) => p.tag === 'starter' || p.tag === 'system').length,
      payments_untagged: weekPayments.filter((p) => p.tag === 'untagged').length,
      payers_incentivised: incentivised.length,
      payers_incentivised_repeat_rate: ratio(repeatOf(incentivised), incentivised.length),
      payers_not_incentivised: notIncentivised.length,
      payers_not_incentivised_repeat_rate: ratio(repeatOf(notIncentivised), notIncentivised.length),
      referrals_qualified_new: [...qualifiedAt.values()].filter(inWeek).length,
      referrals_qualified_total: [...qualifiedAt.values()].filter((t) => t < e).length,
      api_requests: weekReq.length,
      api_request_errors: weekReq.filter((r) => r.status >= 400).length,
      api_platforms_active: new Set(weekReq.map((r) => r.platformAccountId ?? '')).size,
      api_payouts_created: payouts.length,
      api_payouts_confirmed: payoutsConfirmed,
      api_payouts_failed: payoutsFailed,
      api_payout_success_rate: ratio(payoutsConfirmed, payoutsConfirmed + payoutsFailed),
      api_payments_created: checkouts.length,
      api_payments_confirmed: checkoutsConfirmed,
      api_payments_expired: checkoutsExpired,
      api_payment_success_rate: ratio(checkoutsConfirmed, checkoutsConfirmed + checkoutsExpired),
    });
  }

  const dialOf = new Map<string, string>();
  for (const p of input.phones) if (p.dial && !dialOf.has(p.accountId)) dialOf.set(p.accountId, p.dial);
  const byDial = new Map<string, number>();
  for (const a of accounts) {
    const dial = dialOf.get(a.id) ?? '';
    byDial.set(dial, (byDial.get(dial) ?? 0) + 1);
  }
  const countries = [...byDial.entries()]
    .map(([dial, n]) => ({ dial, accounts: n }))
    .sort((a, b) => b.accounts - a.accounts || a.dial.localeCompare(b.dial));

  return { definitionVersion: TRACTION_DEFINITION_VERSION, excluded: opts.exclude, weeks, countries };
}

/** The weeks as CSV, one row per week, every metric a column. */
export function tractionCsv(result: TractionResult): string {
  if (!result.weeks.length) return '';
  const cols = Object.keys(result.weeks[0]) as Array<keyof WeekMetrics>;
  const cell = (v: unknown) => (v == null ? '' : String(v));
  return [cols.join(','), ...result.weeks.map((w) => cols.map((c) => cell(w[c])).join(','))].join('\n') + '\n';
}
