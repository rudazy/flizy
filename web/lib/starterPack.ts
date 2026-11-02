import { getSupabase } from './supabase.ts';
import { STARTER_AMOUNT_ETH, STARTER_HOST } from './starterHost.ts';

/**
 * The starter pack on Home: link a chat, take free test ETH, send a small
 * amount to the founder's account from that chat, and make a first swap.
 *
 * This file answers the two steps the other reads do not: whether a WhatsApp
 * or Telegram chat is linked, and whether the account has sent at least
 * STARTER_AMOUNT_ETH in ETH to STARTER_HOST. Any confirmed send counts, from
 * chat or from the site; the card only suggests chat because it is the easy way.
 */

type Db = ReturnType<typeof getSupabase>;

export type StarterProgress = { chatLinked: boolean; paidHost: boolean };

const CHAT_CHANNELS = ['whatsapp', 'telegram'];
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function isEth(row: { asset: string | null; token_address: string | null }): boolean {
  return !row.token_address && (!row.asset || row.asset.toUpperCase() === 'ETH');
}

export async function starterProgress(accountId: string, client?: Db): Promise<StarterProgress> {
  const supabase = client ?? getSupabase();

  const { data: chats, error: chatErr } = await supabase
    .from('channel_identities')
    .select('channel')
    .eq('account_id', accountId)
    .in('channel', CHAT_CHANNELS)
    .limit(1);
  if (chatErr) throw new Error(chatErr.message);

  const { data: host, error: hostErr } = await supabase
    .from('accounts')
    .select('id, agent_wallet_address')
    .eq('username', STARTER_HOST)
    .maybeSingle();
  if (hostErr) throw new Error(hostErr.message);
  const h = host as { id: string; agent_wallet_address: string | null } | null;
  const wallet = h?.agent_wallet_address ?? '';

  // No one to pay (the host is this account, or has no wallet): the step is
  // not asked of anyone rather than left open forever.
  let paidHost = !h || h.id === accountId || !ADDRESS_RE.test(wallet);
  if (!paidHost) {
    const { data: sends, error: sendErr } = await supabase
      .from('transfers')
      .select('amount_eth, asset, token_address')
      .eq('account_id', accountId)
      .eq('status', 'confirmed')
      .eq('kind', 'transfer')
      .ilike('to_address', wallet)
      .limit(50);
    if (sendErr) throw new Error(sendErr.message);
    paidHost = ((sends || []) as { amount_eth: string | number | null; asset: string | null; token_address: string | null }[]).some(
      (s) => isEth(s) && Number(s.amount_eth) >= STARTER_AMOUNT_ETH
    );
  }

  return { chatLinked: (chats || []).length > 0, paidHost };
}
