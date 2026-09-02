/**
 * Admin commands: pool, escrow, users, claimadmin, credit.
 *
 * Operator surface, not product surface. Everything here is gated on
 * isAdminUser and answers a question about the system rather than moving a
 * user's money -- except credit, which writes the legacy balance and is the
 * reason this file is worth reading carefully.
 *
 * First handler group out of router.js, chosen because it is the smallest one
 * that touches real state: if the shape of these modules is wrong, the blast
 * radius is a few admin commands rather than the send path. Claims and swap
 * follow once this pattern has survived contact.
 *
 * Dependencies go one way. This imports runtime, config and the chat layer;
 * nothing here imports router, which is what keeps the extraction from
 * becoming a cycle.
 *
 * NOTE on credit, because two things share the word and one of them is money:
 *
 *   users.balance_eth     authoritative. What this file writes, what a send
 *                         spends, gated by ENFORCE_CREDIT (default false).
 *   accounts.balance_eth  a mirror of the above, kept so the site has a row
 *                         to read. Never the source of truth.
 *   invite credit         not this at all. Derived from counted_at, never
 *                         spendable. See lib/inviteCredits.js.
 */

const { ethers } = require('ethers');
const { config } = require('../config');
const {
  supabase,
  provider,
  opsWallet,
  escrowWallet,
  addressUrl,
  getOpsBalanceEth,
} = require('../runtime');
const { publicErrorMessage } = require('../sanitize');
const { reply, cmd, isAdminUser, formatEth } = require('../commands/chat');

/**
 * Absolute set of a user's credit. Admin top-ups only.
 *
 * Spending credit does NOT go through here. A send reserves its amount with the
 * guarded decrement in lib/credit.js, because an absolute write computed from an
 * earlier read loses one of two concurrent debits.
 *
 * Lives beside the command that performs it, and selects only the two fields
 * that command renders rather than the whole row.
 */
async function setUserBalance(userId, newBalanceEth) {
  const { data, error } = await supabase
    .from('users')
    .update({ balance_eth: newBalanceEth })
    .eq('id', userId)
    .select('phone, balance_eth')
    .single();
  if (error) throw new Error(`Balance update failed: ${error.message}`);
  return data;
}

async function handlePool(ctx, user) {
  if (!isAdminUser(user)) {
    await reply(ctx, `Pool is admin-only. Use ${cmd(ctx, 'balance')} for your credit.`);
    return;
  }
  try {
    const pool = await getOpsBalanceEth();
    await reply(
      ctx,
      [
        'Ops wallet (gas / infra — not claim escrow)',
        `${formatEth(pool)} ETH`,
        opsWallet.address,
        addressUrl(opsWallet.address),
        '',
        `Claim escrow: ${cmd(ctx, 'escrow')}`,
      ].join('\n')
    );
  } catch (err) {
    console.error('pool error:', publicErrorMessage(err));
    await reply(ctx, 'Could not read pool balance.');
  }
}

async function handleEscrow(ctx, user) {
  if (!isAdminUser(user)) {
    await reply(ctx, 'Escrow status is admin-only.');
    return;
  }
  try {
    const text = await formatEscrowStatus(provider);
    await reply(ctx, [text, addressUrl(escrowWallet.address)].join('\n'));
  } catch (err) {
    console.error('escrow status:', publicErrorMessage(err));
    await reply(ctx, 'Could not read escrow status.');
  }
}

/**
 * invite -- your link, who it brought, and what that is worth.
 *
 * Split out of the how-to text, which answered `invite` with a generic guide and
 * never showed the link at all. The credit only existed on the dashboard until
 * now, which is the wrong place for a product people live in from chat.
 */
async function handleInvite(ctx, account) {
  try {
    const acc = await resolveLinkedSiteAccount(ctx, account);
    if (!acc) {
      await reply(
        ctx,
        [
          'Link your site account to get your invite link.',
          `Site: ${config.siteUrl}/dashboard`,
          `Generate a code, then: ${cmd(ctx, 'link CODE')}`,
        ].join('\n')
      );
      return;
    }
    const summary = await getInviteSummary(supabase, acc.id, config.siteUrl);
    if (!summary) {
      await reply(ctx, 'Could not read your invite link. Try again shortly.');
      return;
    }
    await reply(
      ctx,
      [
        'Your invite link',
        summary.url,
        '',
        `Signed up: ${summary.attributed}`,
        `Counted:   ${summary.counted}`,
        `Credits:   ${summary.credits}`,
      ].join('\n')
    );
  } catch (err) {
    console.error('invite error:', publicErrorMessage(err));
    await reply(ctx, 'Could not read your invites. Try again shortly.');
  }
}

async function handleUsers(ctx, user) {
  if (!isAdminUser(user)) {
    await reply(ctx, 'Users list is admin-only.');
    return;
  }
  const { data, error } = await supabase
    .from('users')
    .select('phone, balance_eth, is_admin, created_at')
    .order('created_at', { ascending: false })
    .limit(15);

  if (error) {
    await reply(ctx, 'Could not list users.');
    return;
  }
  if (!data?.length) {
    await reply(ctx, 'No users yet.');
    return;
  }

  const lines = ['Recent users:'];
  for (const u of data) {
    lines.push(`• ${u.phone}  credit=${formatEth(u.balance_eth)}  ${u.is_admin ? 'admin' : 'user'}`);
  }
  await reply(ctx, lines.join('\n'));
}

async function handleClaimAdmin(ctx, user, secret) {
  const expected = config.adminSetupSecret;
  if (!expected || expected === 'changeme') {
    await reply(
      ctx,
      'Admin setup is not configured.\nSet ADMIN_SETUP_SECRET in .env (not "changeme"), restart, then:\nclaimadmin your-secret'
    );
    return;
  }
  if (secret !== expected) {
    await reply(ctx, 'Invalid setup secret.');
    return;
  }
  if (user.is_admin) {
    await reply(ctx, 'You are already an admin.');
    return;
  }
  const { data, error } = await supabase
    .from('users')
    .update({ is_admin: true })
    .eq('id', user.id)
    .select('phone, is_admin')
    .single();
  if (error) {
    await reply(ctx, 'Could not promote. Try again.');
    return;
  }
  await reply(
    ctx,
    [
      'You are now an admin.',
      `Id: ${data.phone}`,
      '',
      'You can:',
      '  credit <id> 0.01',
      '  pool',
      '  users',
    ].join('\n')
  );
}

async function handleCredit(ctx, adminUser, targetPhone, amountEth) {
  if (!isAdminUser(adminUser)) {
    await reply(ctx, 'Only admins can credit balances.');
    return;
  }

  let amount;
  try {
    amount = Number(amountEth);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('bad amount');
    ethers.parseEther(String(amountEth));
  } catch {
    await reply(ctx, 'Invalid amount. Example: credit 2348012345678 0.01');
    return;
  }

  const key = normalizePhoneNumber(targetPhone);
  if (key.length < 6) {
    await reply(
      ctx,
      'Invalid id. Use digits with country code, no +.\nExample: credit 2348012345678 0.01'
    );
    return;
  }

  try {
    const { data: target, error } = await supabase
      .from('users')
      .select(USER_COLS)
      .eq('phone', key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!target) {
      await reply(ctx, 'No such user yet. They must message the bot once first.');
      return;
    }
    const next = Number(target.balance_eth || 0) + amount;
    const updated = await setUserBalance(target.id, next);
    await reply(
      ctx,
      [
        'Credit added.',
        `User: ${updated.phone}`,
        `Added: ${formatEth(amount)} ETH`,
        `New credit: ${formatEth(updated.balance_eth)} ETH`,
      ].join('\n')
    );
  } catch (err) {
    console.error('credit error:', publicErrorMessage(err));
    await reply(ctx, 'Credit failed. Try again.');
  }
}
module.exports = {
  handlePool,
  handleEscrow,
  handleUsers,
  handleClaimAdmin,
  handleCredit,
};
