import { NextResponse } from 'next/server';
import { getSupabase, getSiteConfig } from '../../../lib/supabase';
import { listTrusted } from '../../../lib/trusted';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { predictGatorAddress } from '../../../lib/gatorAccount.ts';
import { toPublicAccount } from '../../../lib/publicAccount';
import { listPendingClaimSummaries } from '../../../lib/pendingClaims';
import { apiErrorBody, logApiError } from '../../../lib/apiError';
import { getInviteSummary } from '../../../lib/invite.ts';
import { getPaySummary } from '../../../lib/payCode.ts';
import { DEFAULT_APPEARANCE, type PublicAppearance } from '../../../lib/appearance';
import { readAppearance } from '../../../lib/accountBackground';

const ROUTE = 'GET /api/dashboard';

const ACCOUNT_COLS_BASE =
  'id, email, email_verified_at, display_name, username, username_changed_at, locale, agent_wallet_address, unlock_pin_hash, balance_eth, daily_send_limit_eth';
const ACCOUNT_COLS_DIAL = `${ACCOUNT_COLS_BASE}, default_calling_code`;
const ACCOUNT_COLS = `${ACCOUNT_COLS_DIAL}, default_country_iso`;

/**
 * The column arrives in a hand-applied migration. A deploy that lands first
 * must still load the dashboard. A missing column reads as no saved country.
 */
function missingCallingCodeColumn(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  const code = String(error.code || '');
  const message = String(error.message || '');
  return (
    code === '42703' ||
    code === 'PGRST204' ||
    (/default_calling_code/i.test(message) && /column|schema cache/i.test(message))
  );
}

async function selectAccount(
  supabase: ReturnType<typeof getSupabase>,
  accountId: string
) {
  const full = await supabase.from('accounts').select(ACCOUNT_COLS).eq('id', accountId).single();
  if (!full.error) return full;
  const message = String(full.error.message || '');
  if (/default_country_iso/i.test(message)) {
    const dial = await supabase.from('accounts').select(ACCOUNT_COLS_DIAL).eq('id', accountId).single();
    if (!missingCallingCodeColumn(dial.error)) return dial;
    return supabase.from('accounts').select(ACCOUNT_COLS_BASE).eq('id', accountId).single();
  }
  if (!missingCallingCodeColumn(full.error)) return full;
  return supabase.from('accounts').select(ACCOUNT_COLS_BASE).eq('id', accountId).single();
}

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const supabase = getSupabase();
    let { data: account, error } = await selectAccount(supabase, accountId);

    if (error || !account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Set the agent wallet once and never replace it. An empty pointer gets the
    // HybridDeleGator. Anything already stored is left alone because funds may
    // be sitting on it and it is the account's on-chain identity.
    const stored = account.agent_wallet_address;

    if (!stored) {
      const { data: updated, error: uErr } = await supabase
        .from('accounts')
        .update({ agent_wallet_address: predictGatorAddress(accountId) })
        .eq('id', accountId)
        .is('agent_wallet_address', null)
        .select(ACCOUNT_COLS)
        .single();
      if (!uErr && updated) {
        account = updated;
      } else {
        // Re-read in case another request got there first
        const { data: again } = await selectAccount(supabase, accountId);
        if (again) account = again;
      }
    }

    const trusted = await listTrusted(accountId);

    // Whether a chat app is linked, never the live link code. The code is a
    // credential that attaches a chat to this account, so it is returned only by
    // POST /api/link/create, to the browser that proved the password.
    const { count: chatCount } = await supabase
      .from('channel_identities')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .in('channel', ['whatsapp', 'telegram']);
    const chatLinked = (chatCount || 0) > 0;

    let pendingClaims: Awaited<ReturnType<typeof listPendingClaimSummaries>> = [];
    try {
      pendingClaims = await listPendingClaimSummaries(accountId);
    } catch (err) {
      // Dashboard still loads if claims query fails; surface nothing rather than 500.
      // Log the error object, not err.message in a ternary (static leak guard).
      console.warn('[dashboard] pendingClaims failed', err);
    }

    // Taken from the function rather than re-typed: this was a third hand-written
    // copy of the invite shape, and it had already fallen behind by one field.
    let invite: Awaited<ReturnType<typeof getInviteSummary>> = null;
    if (account.username) {
      try {
        invite = await getInviteSummary(supabase, accountId, getSiteConfig().siteUrl);
      } catch (err) {
        console.warn('[dashboard] invite summary', err);
      }
    }

    // Taken from the function rather than re-typed, so a new field cannot leave
    // this declaration behind.
    let pay: Awaited<ReturnType<typeof getPaySummary>> = null;
    if (account.username) {
      try {
        pay = await getPaySummary(supabase, accountId, getSiteConfig().siteUrl);
      } catch (err) {
        console.warn('[dashboard] pay summary', err);
      }
    }

    let appearance: PublicAppearance = { ...DEFAULT_APPEARANCE };
    try {
      appearance = await readAppearance(supabase, accountId);
    } catch (err) {
      logApiError(ROUTE, err, { step: 'appearance' });
    }

    return NextResponse.json({
      account: toPublicAccount(account),
      trusted,
      chatLinked,
      pendingClaims,
      invite,
      pay,
      appearance,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
