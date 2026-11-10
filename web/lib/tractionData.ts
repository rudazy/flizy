import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { internationalCallingPrefix } from '../../lib/phoneCountries.js';
import type { TractionInput } from './traction.ts';

/**
 * The rows the traction metrics are computed from (web/lib/traction.ts), read
 * with the service role. Server only. Addresses and phone numbers are read so
 * a payment can be matched to the account that received it and an account to
 * its country; they are turned into account ids, opaque keys and calling codes
 * here and never leave the server. The page and the CSV carry counts only.
 */

const PAGE = 1000;

/** Every row a query returns, a page at a time. */
async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message?: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message || 'traction read failed');
    const rows = (data as T[]) || [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** A stable key for who an unclaimed claim is for, without the value itself. */
function recipientKey(row: { to_wa_hint?: string | null; to_email?: string | null; to_channel?: string | null; to_external_id?: string | null }): string {
  const raw = row.to_channel && row.to_external_id
    ? `p:${row.to_channel}:${row.to_external_id}`
    : row.to_email
      ? `e:${String(row.to_email).toLowerCase()}`
      : `w:${String(row.to_wa_hint || '').replace(/\D/g, '')}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

export async function loadTractionInput(db: SupabaseClient, now = Date.now()): Promise<TractionInput> {
  const [accounts, links, transfers, payoutTx, claims, faucet, winners, invites, requests, apiTx, platforms, phones, excluded] = await Promise.all([
    all<{ id: string; created_at: string; email: string | null; email_verified_at: string | null; deleted_at: string | null; agent_wallet_address: string | null }>((a, b) =>
      db.from('accounts').select('id, created_at, email, email_verified_at, deleted_at, agent_wallet_address').order('id').range(a, b)
    ),
    all<{ account_id: string | null; created_at: string }>((a, b) =>
      db.from('identity_events').select('account_id, created_at').eq('event_type', 'LINKED').in('channel', ['whatsapp', 'telegram']).order('id').range(a, b)
    ),
    all<{ id: string; account_id: string | null; to_address: string | null; status: string; kind: string | null; created_at: string; incentive_tag: string | null }>((a, b) =>
      db.from('transfers').select('id, account_id, to_address, status, kind, created_at, incentive_tag').eq('status', 'confirmed').order('id').range(a, b)
    ),
    all<{ transfer_id: string }>((a, b) => db.from('api_transactions').select('transfer_id').eq('kind', 'payout').not('transfer_id', 'is', null).order('id').range(a, b)),
    all<{
      from_account_id: string | null;
      to_account_id: string | null;
      status: string;
      created_at: string;
      expires_at: string | null;
      api_transaction_id: string | null;
      to_wa_hint: string | null;
      to_email: string | null;
      to_channel: string | null;
      to_external_id: string | null;
      incentive_tag: string | null;
    }>((a, b) =>
      db
        .from('claims')
        .select('from_account_id, to_account_id, status, created_at, expires_at, api_transaction_id, to_wa_hint, to_email, to_channel, to_external_id, incentive_tag')
        .order('id')
        .range(a, b)
    ),
    all<{ account_id: string; created_at: string }>((a, b) => db.from('faucet_claims').select('account_id, created_at').in('status', ['sent', 'confirmed']).order('id').range(a, b)),
    all<{ account_id: string; selected_at: string }>((a, b) => db.from('task_winners').select('account_id, selected_at').order('id').range(a, b)),
    all<{ invitee_account_id: string; attributed_at: string }>((a, b) =>
      db.from('invite_attributions').select('invitee_account_id, attributed_at').order('invitee_account_id').range(a, b)
    ),
    all<{ platform_id: string | null; status: number; created_at: string }>((a, b) => db.from('api_requests').select('platform_id, status, created_at').order('id').range(a, b)),
    all<{ platform_id: string; kind: string; state: string; created_at: string }>((a, b) =>
      db.from('api_transactions').select('platform_id, kind, state, created_at').order('id').range(a, b)
    ),
    all<{ id: string; account_id: string }>((a, b) => db.from('api_platforms').select('id, account_id').order('id').range(a, b)),
    all<{ account_id: string | null; phone_e164: string | null }>((a, b) =>
      db.from('channel_identities').select('account_id, phone_e164').not('phone_e164', 'is', null).order('id').range(a, b)
    ),
    all<{ account_id: string }>((a, b) => db.from('metrics_excluded_accounts').select('account_id').order('account_id').range(a, b)),
  ]);

  const platformOwner = new Map(platforms.map((p) => [p.id, p.account_id]));
  const ownerOf = (platformId: string | null) => (platformId ? platformOwner.get(platformId) ?? null : null);

  return {
    now,
    accounts: accounts.map((a) => ({
      id: a.id,
      createdAt: a.created_at,
      hasEmail: Boolean(a.email),
      verified: Boolean(a.email_verified_at),
      deleted: Boolean(a.deleted_at),
      wallet: a.agent_wallet_address,
    })),
    links: links.filter((l) => l.account_id).map((l) => ({ accountId: l.account_id as string, at: l.created_at })),
    transfers: transfers.map((t) => ({ id: t.id, accountId: t.account_id, toAddress: t.to_address, status: t.status, kind: t.kind, at: t.created_at, tag: t.incentive_tag })),
    apiPayoutTransferIds: payoutTx.map((r) => r.transfer_id),
    claims: claims.map((c) => ({
      fromAccountId: c.from_account_id,
      toAccountId: c.status === 'claimed' ? c.to_account_id : null,
      recipientKey: recipientKey(c),
      status: c.status,
      at: c.created_at,
      expiresAt: c.expires_at,
      fromApi: Boolean(c.api_transaction_id),
      tag: c.incentive_tag,
    })),
    incentives: [
      ...faucet.map((f) => ({ accountId: f.account_id, at: f.created_at, kind: 'faucet' as const })),
      ...winners.map((w) => ({ accountId: w.account_id, at: w.selected_at, kind: 'task' as const })),
    ],
    invites: invites.map((i) => ({ invitee: i.invitee_account_id, at: i.attributed_at })),
    apiRequests: requests.map((r) => ({ platformAccountId: ownerOf(r.platform_id), at: r.created_at, status: Number(r.status) })),
    apiTransactions: apiTx.map((r) => ({ platformAccountId: ownerOf(r.platform_id), kind: r.kind, state: r.state, at: r.created_at })),
    phones: phones
      .filter((p) => p.account_id)
      .map((p) => ({ accountId: p.account_id as string, dial: internationalCallingPrefix(String(p.phone_e164 || '').replace(/\D/g, '')) })),
    excluded: excluded.map((e) => e.account_id),
  };
}
