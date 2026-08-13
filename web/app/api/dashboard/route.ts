import { NextResponse } from 'next/server';
import { getSupabase, getSiteConfig } from '../../../lib/supabase';
import { listTrusted } from '../../../lib/trusted';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { deriveAgentAddress, deriveLegacyAddressV1 } from '../../../lib/agentWallet';
import { toPublicAccount } from '../../../lib/publicAccount';
import { listPendingClaimSummaries } from '../../../lib/pendingClaims';
import { apiErrorBody } from '../../../lib/apiError';
import { getInviteSummary } from '../../../lib/invite.ts';

const ROUTE = 'GET /api/dashboard';

const ACCOUNT_COLS =
  'id, email, email_verified_at, display_name, username, username_changed_at, locale, agent_wallet_address, unlock_pin_hash, balance_eth, daily_send_limit_eth';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const supabase = getSupabase();
    let { data: account, error } = await supabase
      .from('accounts')
      .select(ACCOUNT_COLS)
      .eq('id', accountId)
      .single();

    if (error || !account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Set the agent wallet once. An address our own v1 code wrote is moved
    // forward to the v2 address the signer actually controls; anything else is
    // left alone because funds may be sitting on it.
    const expected = deriveAgentAddress(accountId);
    const stored = account.agent_wallet_address;
    const isLegacyPointer = Boolean(stored) && stored === deriveLegacyAddressV1(accountId);

    if (!stored || isLegacyPointer) {
      let write = supabase.from('accounts').update({ agent_wallet_address: expected });
      write = stored
        ? write.eq('id', accountId).eq('agent_wallet_address', stored)
        : write.eq('id', accountId).is('agent_wallet_address', null);

      const { data: updated, error: uErr } = await write.select(ACCOUNT_COLS).single();
      if (!uErr && updated) {
        account = updated;
      } else {
        // Re-read in case another request got there first
        const { data: again } = await supabase
          .from('accounts')
          .select(ACCOUNT_COLS)
          .eq('id', accountId)
          .single();
        if (again) account = again;
      }
    }

    const trusted = await listTrusted(accountId);

    const { data: linkRow } = await supabase
      .from('link_codes')
      .select('code, expires_at')
      .eq('account_id', accountId)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let link = null;
    if (linkRow) {
      const { botWhatsAppNumber, telegramBotUsername } = getSiteConfig();
      const prefill = encodeURIComponent(`flizy link ${linkRow.code}`);
      link = {
        code: linkRow.code,
        expiresAt: linkRow.expires_at,
        waDeepLink: botWhatsAppNumber
          ? `https://wa.me/${botWhatsAppNumber}?text=${prefill}`
          : `https://wa.me/?text=${prefill}`,
        // Same code, any channel. Telegram fills it in via the start parameter.
        telegramDeepLink: telegramBotUsername
          ? `https://t.me/${telegramBotUsername}?start=${linkRow.code}`
          : null,
      };
    }

    let pendingClaims: Awaited<ReturnType<typeof listPendingClaimSummaries>> = [];
    try {
      pendingClaims = await listPendingClaimSummaries(accountId);
    } catch (err) {
      // Dashboard still loads if claims query fails; surface nothing rather than 500.
      // Log the error object, not err.message in a ternary (static leak guard).
      console.warn('[dashboard] pendingClaims failed', err);
    }

    let invite: { code: string; url: string; counted: number } | null = null;
    if (account.username) {
      try {
        invite = await getInviteSummary(supabase, accountId, getSiteConfig().siteUrl);
      } catch (err) {
        console.warn('[dashboard] invite summary', err);
      }
    }

    return NextResponse.json({
      account: toPublicAccount(account),
      trusted,
      link,
      pendingClaims,
      invite,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
