/**
 * Web claim payout (Stage 1.4).
 *
 * Mirrors lib/engine/executeClaim.js executeClaimPayout for Vercel:
 * no root lib/ on deploy. Match rules stay the same as the bot:
 *   phone     → account must hold phone_e164 on some channel_identities row
 *   platform  → account must hold (channel, external_id)
 * Race: status pending → processing → claimed (or back to pending if pre-chain fail).
 *
 * Escrow signs with ESCROW_PRIVATE_KEY (or same derived key as the bot).
 * Agent receive address uses the same derivation as chat (web/lib/agentWallet).
 */

import { ethers } from 'ethers';
import { getSupabase } from './supabase.ts';
import { deriveAgentAddress, deriveAgentPrivateKey } from './agentWallet.ts';
import { getWebChain } from './dexServer.ts';
import { formatUsernameLabel } from './username.ts';
import {
  claimMatchesAccountKeys,
  claimViaLine,
  formatClaimClaimedNotice,
  isPlausiblePhoneDigits,
  matchErrorForClaim,
  normalizePhoneDigits,
  type ClaimMatchRow,
} from './claimMatch.ts';
import { parseEmail } from './email.ts';

export type ClaimRow = ClaimMatchRow & {
  id: string;
  status: string;
  amount_eth: string | number;
  from_account_id: string;
  claim_token?: string | null;
  chain_id?: number | null;
};

export type PayoutResult =
  | {
      ok: true;
      claim: ClaimRow;
      claimTxHash: string;
      explorerUrl: string | null;
    }
  | { ok: false; error: string; status?: number };

export {
  claimMatchesAccountKeys,
  claimViaLine,
  formatClaimClaimedNotice,
  matchErrorForClaim,
} from './claimMatch.ts';

function getEscrowWallet(provider: ethers.Provider): ethers.Wallet {
  const explicit = process.env.ESCROW_PRIVATE_KEY || '';
  let wallet: ethers.Wallet;
  if (explicit && !/^your_/i.test(explicit) && !explicit.includes('placeholder')) {
    wallet = new ethers.Wallet(explicit);
  } else {
    const ops = process.env.PRIVATE_KEY || '';
    if (!ops) {
      throw new Error('ESCROW_PRIVATE_KEY or PRIVATE_KEY required for claim payout');
    }
    const material = ethers.keccak256(ethers.toUtf8Bytes(`flizy:escrow:v1:${ops}`));
    wallet = new ethers.Wallet(material);
  }
  return wallet.connect(provider);
}

function gasBufferWei(): bigint {
  const raw = process.env.GAS_BUFFER_ETH || '0.0001';
  try {
    return ethers.parseEther(String(raw));
  } catch {
    return ethers.parseEther('0.0001');
  }
}

/** Match keys this account can use for claim payout. */
export async function claimKeysForAccount(accountId: string): Promise<{
  phones: string[];
  identities: Array<{ channel: string; externalId: string }>;
  emails: string[];
}> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('channel_identities')
    .select('channel, external_id, phone_e164')
    .eq('account_id', accountId);
  if (error) throw new Error(error.message);

  const phones: string[] = [];
  const identities: Array<{ channel: string; externalId: string }> = [];
  const emails: string[] = [];

  for (const row of data || []) {
    const phone = normalizePhoneDigits(row.phone_e164);
    if (phone && isPlausiblePhoneDigits(phone) && !phones.includes(phone)) {
      phones.push(phone);
    }
    if (row.channel && row.external_id) {
      const ch = String(row.channel);
      const id = String(row.external_id).trim();
      if (id && !identities.some((i) => i.channel === ch && i.externalId === id)) {
        identities.push({ channel: ch, externalId: id });
      }
    }
  }

  const { data: acc, error: aErr } = await supabase
    .from('accounts')
    .select('email')
    .eq('id', accountId)
    .maybeSingle();
  if (aErr) throw new Error(aErr.message);
  const primary = parseEmail(acc?.email);
  if (primary) emails.push(primary);

  const { data: extra, error: eErr } = await supabase
    .from('account_emails')
    .select('email')
    .eq('account_id', accountId)
    .not('verified_at', 'is', null);
  if (eErr) {
    // Migration not applied yet: primary still works.
    if (!String(eErr.message || '').includes('account_emails') && eErr.code !== '42P01') {
      throw new Error(eErr.message);
    }
  } else {
    for (const row of extra || []) {
      const e = parseEmail(row.email);
      if (e && !emails.includes(e)) emails.push(e);
    }
  }

  return { phones, identities, emails };
}

async function claimerLabel(accountId: string): Promise<string> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('accounts')
    .select('username, display_name')
    .eq('id', accountId)
    .maybeSingle();
  const u = formatUsernameLabel(data?.username);
  if (u) return u;
  const n = data?.display_name ? String(data.display_name).trim() : '';
  return n || 'another Flizy user';
}

/** Queue notify on every linked channel of the sender (bots drain the outbox). */
async function notifySenderClaimed(
  senderAccountId: string,
  body: string
): Promise<void> {
  const supabase = getSupabase();
  const { data: identities } = await supabase
    .from('channel_identities')
    .select('channel, external_id')
    .eq('account_id', senderAccountId);
  for (const row of identities || []) {
    if (!row.channel || !row.external_id) continue;
    try {
      await supabase.from('notifications').insert({
        account_id: senderAccountId,
        channel: row.channel,
        external_id: String(row.external_id),
        body,
      });
    } catch (err) {
      console.warn('[claimPayout] notify enqueue failed:', err);
    }
  }
}

async function ensureAgentAddress(accountId: string): Promise<string> {
  const address = deriveAgentAddress(accountId);
  const supabase = getSupabase();
  const { data } = await supabase
    .from('accounts')
    .select('agent_wallet_address')
    .eq('id', accountId)
    .maybeSingle();
  if (!data?.agent_wallet_address) {
    await supabase
      .from('accounts')
      .update({ agent_wallet_address: address })
      .eq('id', accountId);
  }
  return address;
}

/**
 * Pay out one pending claim to this logged-in account when identity matches.
 */
export async function executeWebClaimPayout(p: {
  claimId: string;
  accountId: string;
}): Promise<PayoutResult> {
  const { claimId, accountId } = p;
  if (!claimId || !accountId) {
    return { ok: false, error: 'Missing claim or account.', status: 400 };
  }

  const supabase = getSupabase();
  const { data: claim, error: cErr } = await supabase
    .from('claims')
    .select('*')
    .eq('id', claimId)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!claim) return { ok: false, error: 'Claim not found.', status: 404 };
  if (String(claim.status) !== 'pending') {
    return { ok: false, error: `Claim is already ${claim.status}.`, status: 409 };
  }

  // Phone claims: ownership is proven only in WhatsApp/Telegram (contact share /
  // channel metadata). Web may show the hold, but payout stays chat-only.
  const isPhoneClaim = !claim.to_channel && Boolean(claim.to_wa_hint);
  if (isPhoneClaim) {
    return {
      ok: false,
      error:
        'Phone claims can only be received in WhatsApp or Telegram after that number is proven on that chat. Open the bot and send: flizy claim',
      status: 403,
    };
  }

  const keys = await claimKeysForAccount(accountId);
  if (!claimMatchesAccountKeys(claim as ClaimRow, keys)) {
    return { ok: false, error: matchErrorForClaim(claim as ClaimRow, keys), status: 403 };
  }

  // Race lock
  const { data: held, error: hErr } = await supabase
    .from('claims')
    .update({ status: 'processing' })
    .eq('id', claimId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (hErr) throw new Error(hErr.message);
  if (!held) {
    return { ok: false, error: 'That claim is already being processed.', status: 409 };
  }

  const chain = getWebChain();
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
  let submitted = false;

  try {
    const amountWei = ethers.parseEther(String(held.amount_eth));
    if (amountWei <= 0n) {
      await supabase.from('claims').update({ status: 'pending' }).eq('id', claimId).eq('status', 'processing');
      return { ok: false, error: 'Invalid claim amount.', status: 400 };
    }

    const toAddress = await ensureAgentAddress(accountId);
    // Touch derivation so secret is validated even if we only send TO the address
    void deriveAgentPrivateKey(accountId);

    const escrow = getEscrowWallet(provider);
    const escBal = await provider.getBalance(escrow.address);
    if (escBal < amountWei + gasBufferWei()) {
      await supabase.from('claims').update({ status: 'pending' }).eq('id', claimId).eq('status', 'processing');
      return {
        ok: false,
        error: 'Payout temporarily unavailable. Try again later.',
        status: 503,
      };
    }

    const network = await provider.getNetwork();
    if (Number(network.chainId) !== chain.chainId) {
      await supabase.from('claims').update({ status: 'pending' }).eq('id', claimId).eq('status', 'processing');
      return { ok: false, error: 'Network mismatch. Try again shortly.', status: 503 };
    }

    const tx = await escrow.sendTransaction({
      to: toAddress,
      value: amountWei,
    });
    submitted = true;

    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      await supabase.from('claims').update({ status: 'pending' }).eq('id', claimId).eq('status', 'processing');
      return { ok: false, error: 'Payout transaction failed.', status: 502 };
    }

    const { data: updated, error: uErr } = await supabase
      .from('claims')
      .update({
        status: 'claimed',
        to_account_id: accountId,
        claimed_at: new Date().toISOString(),
        claim_tx_hash: tx.hash,
        tx_hash: tx.hash,
      })
      .eq('id', claimId)
      .eq('status', 'processing')
      .select('*')
      .single();
    if (uErr) throw new Error(uErr.message);

    const explorerUrl = `${chain.explorerBaseUrl}/tx/${tx.hash}`;
    const byLabel = await claimerLabel(accountId);
    const viaLine = claimViaLine(updated as ClaimRow);
    if (updated.from_account_id) {
      await notifySenderClaimed(
        updated.from_account_id,
        formatClaimClaimedNotice({
          amountEth: updated.amount_eth,
          byLabel,
          viaLine,
          explorerUrl,
        })
      );
    }

    return {
      ok: true,
      claim: updated as ClaimRow,
      claimTxHash: tx.hash,
      explorerUrl,
    };
  } catch (err) {
    console.error('[claimPayout]', err instanceof Error ? err.message : err);
    if (!submitted) {
      try {
        await supabase
          .from('claims')
          .update({ status: 'pending' })
          .eq('id', claimId)
          .eq('status', 'processing');
      } catch {
        /* preserve processing if release fails */
      }
      return {
        ok: false,
        error: 'Claim failed. Try again shortly.',
        status: 500,
      };
    }
    return {
      ok: false,
      error: 'Payout may be in flight. Check your balance before retrying.',
      status: 500,
    };
  }
}

export async function getClaimById(claimId: string): Promise<ClaimRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('claims').select('*').eq('id', claimId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ClaimRow) || null;
}
