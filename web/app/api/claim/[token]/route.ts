import { NextResponse } from 'next/server';
import { getClaimByToken } from '../../../../lib/claims';
import { publicClaimAccess, publicRecipientLabel } from '../../../../lib/claimRecipient';
import { apiErrorBody } from '../../../../lib/apiError';
import { INVITE_SOURCE_CLAIM, isInviteCodeFormat, normalizeInviteCode } from '../../../../lib/invite.ts';
import { attachInviteCookie } from '../../../../lib/inviteCookie.ts';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { displaySafeLabel } from '../../../../lib/sanitize.ts';
import { formatUsernameLabel } from '../../../../lib/username.ts';
import { claimKeysForAccount, claimMatchesAccountKeys, type ClaimRow } from '../../../../lib/claimPayout';
import { claimShareFor } from '../../../../lib/claimShareView.ts';
import { recordClaimEvent } from '../../../../../lib/claimEvents.js';

const ROUTE = 'GET /api/claim/[token]';

/**
 * The claim page's data. Anyone holding the link sees who sent it, what, that
 * it is testnet, and its expiry: nothing about who it was sent to, and nothing
 * that says whether any identity has a Flizy account. A signed-in viewer is
 * also told where they stand: the sender (with the link to share), the
 * recipient (who can claim), or someone else (told which identity the payment
 * was sent to, masked, so they can add and verify it).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const claim = await getClaimByToken((await ctx.params).token);
    if (!claim) return NextResponse.json({ error: 'Claim not found' }, { status: 404 });
    const db = getSupabase();
    const viewerId = await getAccountIdFromCookie();
    const isSender = Boolean(viewerId) && viewerId === claim.from_account_id;

    // The sender's timeline shows the first open by anyone but the sender.
    // Nothing about who opened it is kept: no IP, no browser, no account.
    if (claim.status === 'pending' && !isSender) {
      await recordClaimEvent(db, String(claim.id), 'link_opened');
    }

    const { data: from } = await db.from('accounts').select('username, display_name').eq('id', claim.from_account_id).maybeSingle();
    const sender =
      formatUsernameLabel(from?.username) || (from?.display_name ? displaySafeLabel(String(from.display_name)) : '') || 'A Flizy user';

    const body: Record<string, unknown> = {
      amount_eth: claim.amount_eth,
      asset: String(claim.asset || 'ETH').toUpperCase(),
      nft_token_id: claim.nft_token_id ? String(claim.nft_token_id) : null,
      status: claim.status,
      sender,
      testnet: true,
      expires_at: claim.expires_at || null,
    };

    if (viewerId) {
      if (isSender) {
        body.viewer = 'sender';
        body.share = claim.status === 'pending' ? claimShareFor(claim) : null;
        body.claim_id = claim.id;
      } else {
        const access = publicClaimAccess(claim);
        const keys = await claimKeysForAccount(viewerId);
        if (claimMatchesAccountKeys(claim as ClaimRow, keys)) {
          body.viewer = 'recipient';
          // A phone claim is received in chat, where the number is proven.
          body.can_claim_on_web = access.can_claim_on_web;
        } else {
          body.viewer = 'other';
          body.recipient_kind = access.recipient_kind;
          body.sent_to = publicRecipientLabel(claim) || null;
        }
      }
    }

    const res = NextResponse.json(body);
    // Cookie is the attribution path. Trust only the snapshot on the hold, never ?i=.
    const stored = normalizeInviteCode(claim.invite_code);
    if (isInviteCodeFormat(stored)) attachInviteCookie(res, stored, INVITE_SOURCE_CLAIM);
    return res;
  } catch (err) {
    // This route is reachable without logging in, from a link that gets pasted
    // around, so it is the cheapest place to probe. The token is the credential
    // for that claim and never goes in the log.
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
