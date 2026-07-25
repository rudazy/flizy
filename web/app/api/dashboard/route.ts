import { NextResponse } from 'next/server';
import { getSupabase, getSiteConfig } from '../../../lib/supabase';
import { listTrusted } from '../../../lib/trusted';
import { getAccountIdFromCookie } from '../../../lib/cookies';

export async function GET() {
  try {
    const accountId = getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const supabase = getSupabase();
    let { data: account, error } = await supabase
      .from('accounts')
      .select(
        'id, email, display_name, agent_wallet_address, unlock_pin_hash, balance_eth, daily_send_limit_eth'
      )
      .eq('id', accountId)
      .single();

    if (error || !account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Set agent wallet once only (never rotate if already set)
    if (!account.agent_wallet_address) {
      const { Wallet, keccak256, toUtf8Bytes } = await import('ethers');
      const material = keccak256(toUtf8Bytes(`flizy:agent:v1:${account.id}`));
      const w = new Wallet(material);
      const { data: updated, error: uErr } = await supabase
        .from('accounts')
        .update({ agent_wallet_address: w.address })
        .eq('id', account.id)
        .is('agent_wallet_address', null)
        .select(
          'id, email, display_name, agent_wallet_address, unlock_pin_hash, balance_eth, daily_send_limit_eth'
        )
        .single();
      if (!uErr && updated) {
        account = updated;
      } else {
        // Re-read in case another request set it
        const { data: again } = await supabase
          .from('accounts')
          .select(
            'id, email, display_name, agent_wallet_address, unlock_pin_hash, balance_eth, daily_send_limit_eth'
          )
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

    return NextResponse.json({
      account: {
        id: account.id,
        email: account.email,
        display_name: account.display_name,
        agent_wallet_address: account.agent_wallet_address,
        balance_eth: account.balance_eth ?? 0,
        has_pin: Boolean(account.unlock_pin_hash),
        daily_send_limit_eth:
          account.daily_send_limit_eth === null || account.daily_send_limit_eth === undefined
            ? null
            : account.daily_send_limit_eth,
      },
      trusted,
      link,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Dashboard failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
