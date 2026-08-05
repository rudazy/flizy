/**
 * Pending claims visible to a logged-in Flizy account (web).
 *
 * Mirrors listPendingClaimsForAccount in lib/pendingClaims.js: load this
 * account's channel_identities + phones + claimable emails, then match pending
 * claim rows.
 */

import { getSupabase } from './supabase';
import { publicRecipientLabel } from './claimRecipient.ts';
import { parseEmail } from './email.ts';

export type PendingClaimSummary = {
  id: string;
  amountEth: string;
  status: string;
  label: string;
  counterparty: string | null;
  createdAt: string | null;
  /** Present so the user can open /claim/[token] if they have it; never a secret */
  claimToken: string | null;
  /** phone = claim in WA/TG only; platform|email = can claim on site too */
  kind: 'phone' | 'platform' | 'email';
  /** false for phone holds — web may display but not pay out */
  canClaimOnWeb: boolean;
};

/**
 * @param accountId internal id — never returned to the client
 */
export async function listPendingClaimSummaries(
  accountId: string
): Promise<PendingClaimSummary[]> {
  if (!accountId) return [];

  const supabase = getSupabase();
  const { data: identities, error: idErr } = await supabase
    .from('channel_identities')
    .select('channel, external_id, phone_e164, display_handle')
    .eq('account_id', accountId);

  if (idErr) throw new Error(idErr.message);

  const phones = new Set<string>();
  const platformIds: Array<{ channel: string; externalId: string }> = [];
  const emails = new Set<string>();

  for (const row of identities || []) {
    const phone = row.phone_e164 ? String(row.phone_e164).replace(/\D/g, '') : '';
    if (phone) phones.add(phone);
    if (row.channel && row.external_id) {
      platformIds.push({
        channel: String(row.channel),
        externalId: String(row.external_id),
      });
    }
  }

  const { data: acc, error: aErr } = await supabase
    .from('accounts')
    .select('email')
    .eq('id', accountId)
    .maybeSingle();
  if (aErr) throw new Error(aErr.message);
  const primary = parseEmail(acc?.email);
  if (primary) emails.add(primary);

  const { data: extra } = await supabase
    .from('account_emails')
    .select('email')
    .eq('account_id', accountId)
    .not('verified_at', 'is', null);
  for (const row of extra || []) {
    const e = parseEmail(row.email);
    if (e) emails.add(e);
  }

  if (!phones.size && !platformIds.length && !emails.size) return [];

  const found = new Map<string, Record<string, unknown>>();

  const base = () =>
    supabase
      .from('claims')
      .select(
        'id, amount_eth, status, created_at, claim_token, to_wa_hint, to_channel, to_external_id, to_display_handle, to_email'
      )
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50);

  if (phones.size) {
    const list = [...phones];
    let q = base();
    q = list.length === 1 ? q.eq('to_wa_hint', list[0]) : q.in('to_wa_hint', list);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      found.set(String(row.id), row as Record<string, unknown>);
    }
  }

  if (platformIds.length) {
    const channels = [...new Set(platformIds.map((p) => p.channel))];
    const extIds = platformIds.map((p) => p.externalId);
    const { data, error } = await base().in('to_channel', channels).in('to_external_id', extIds);
    if (error) throw new Error(error.message);

    const want = new Set(platformIds.map((p) => `${p.channel}:${p.externalId}`));
    for (const row of data || []) {
      const key = `${row.to_channel}:${row.to_external_id}`;
      if (want.has(key)) found.set(String(row.id), row as Record<string, unknown>);
    }
  }

  if (emails.size) {
    const list = [...emails];
    let q = base();
    q = list.length === 1 ? q.eq('to_email', list[0]) : q.in('to_email', list);
    const { data, error } = await q;
    if (error) {
      // Column missing until migration — skip email holds quietly.
      if (!String(error.message || '').includes('to_email')) throw new Error(error.message);
    } else {
      for (const row of data || []) {
        found.set(String(row.id), row as Record<string, unknown>);
      }
    }
  }

  const rows = [...found.values()].sort((a, b) => {
    const ta = new Date(String(a.created_at || 0)).getTime();
    const tb = new Date(String(b.created_at || 0)).getTime();
    return tb - ta;
  });

  return rows.map((c) => {
    const isPlatform = Boolean(c.to_channel);
    const isEmail = Boolean(c.to_email) && !isPlatform;
    const label =
      publicRecipientLabel({
        to_wa_hint: c.to_wa_hint as string | null,
        to_channel: c.to_channel as string | null,
        to_external_id: c.to_external_id as string | null,
        to_display_handle: c.to_display_handle as string | null,
        to_email: c.to_email as string | null,
      }) || 'Pending claim';
    const peer = c.to_display_handle
      ? `@${String(c.to_display_handle).replace(/^@+/, '')}`
      : c.to_email
        ? String(c.to_email)
        : c.to_wa_hint
          ? `+${String(c.to_wa_hint).replace(/\D/g, '')}`
          : null;
    const rail =
      c.to_channel === 'github'
        ? 'GitHub pay'
        : c.to_channel === 'x'
          ? 'X pay'
          : c.to_channel === 'discord'
            ? 'Discord pay'
            : c.to_channel === 'telegram'
              ? 'Telegram pay'
              : c.to_email
                ? 'Email pay'
                : c.to_wa_hint
                  ? 'Phone pay'
                  : 'Claim';
    return {
      id: String(c.id),
      amountEth: String(c.amount_eth ?? ''),
      status: String(c.status || 'pending'),
      label,
      counterparty: peer ? `${rail} ${peer}` : rail,
      createdAt: c.created_at ? String(c.created_at) : null,
      claimToken: c.claim_token ? String(c.claim_token) : null,
      kind: isPlatform ? ('platform' as const) : isEmail ? ('email' as const) : ('phone' as const),
      // Email and platform claims can pay out on the site; phone remains chat-only.
      canClaimOnWeb: isPlatform || isEmail,
    };
  });
}
