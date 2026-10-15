/**
 * Admin commands: pool, escrow, users, credit.
 *
 * Operator surface, not product surface. Everything here is gated on
 * operatorAllowed: isAdminAccount (accounts.is_admin, set by hand in the SQL
 * editor; nothing in the product grants it) and an unlocked chat. Each answers
 * a question about the system rather than moving a user's money -- except
 * credit, which writes the legacy balance and is the reason this file is worth
 * reading carefully.
 *
 * First handler group out of router.js, chosen because it is the smallest one
 * that touches real state: if the shape of these modules is wrong, the blast
 * radius is a few admin commands rather than the send path. Claims and swap
 * follow once this pattern has survived contact.
 *
 * Dependencies go one way. This imports runtime, session, the chat layer
 * and the account-resolution module; nothing here imports router, which is what
 * keeps the extraction from becoming a cycle.
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
const {
  supabase,
  provider,
  opsWallet,
  escrowWallet,
  addressUrl,
  getOpsBalanceEth,
} = require('../runtime');
const { publicErrorMessage } = require('../sanitize');
const { formatEscrowStatus } = require('../escrowWallet');
const { interpretPhoneInput, normalizePhoneNumber } = require('../phone');
const { reply, cmd, isAdminAccount, formatEth } = require('../commands/chat');
const { USER_COLS } = require('../commands/account');
const { sessionGate } = require('../session');

/**
 * Whether this chat may run an operator command: the account behind it is an
 * admin, and the chat is unlocked with the PIN like any chat that moves money.
 * The flag alone is not enough: `users` lists other people's numbers and
 * `credit` writes balances, so a phone left on an admin's chat must not open
 * them. Replies with the refusal itself and returns false when it refuses.
 *
 * @param {string} notAdmin what to say to an account that is not an admin
 */
async function operatorAllowed(ctx, account, notAdmin) {
  if (!isAdminAccount(account)) {
    await reply(ctx, notAdmin);
    return false;
  }
  const gate = await sessionGate({ accountId: account.id, channel: ctx.channel, externalId: ctx.externalId });
  if (!gate.ok) {
    await reply(ctx, `Operator commands need an unlocked chat. Send ${cmd(ctx, 'unlock')}, then your PIN.`);
    return false;
  }
  return true;
}

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

async function handlePool(ctx, account) {
  if (!(await operatorAllowed(ctx, account, `Pool is admin-only. Use ${cmd(ctx, 'balance')} for your credit.`))) return;
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

async function handleEscrow(ctx, account) {
  if (!(await operatorAllowed(ctx, account, 'Escrow status is admin-only.'))) return;
  try {
    const text = await formatEscrowStatus(provider);
    await reply(ctx, [text, addressUrl(escrowWallet.address)].join('\n'));
  } catch (err) {
    console.error('escrow status:', publicErrorMessage(err));
    await reply(ctx, 'Could not read escrow status.');
  }
}

async function handleUsers(ctx, account) {
  if (!(await operatorAllowed(ctx, account, 'Users list is admin-only.'))) return;
  const { data, error } = await supabase
    .from('users')
    .select('phone, balance_eth, created_at')
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
    lines.push(`• ${u.phone}  credit=${formatEth(u.balance_eth)}`);
  }
  await reply(ctx, lines.join('\n'));
}

async function handleCredit(ctx, account, targetPhone, amountEth) {
  if (!(await operatorAllowed(ctx, account, 'Only admins can credit balances.'))) return;

  let amount;
  try {
    amount = Number(amountEth);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('bad amount');
    ethers.parseEther(String(amountEth));
  } catch {
    await reply(ctx, 'Invalid amount. Example: credit 2348012345678 0.01');
    return;
  }

  const read = interpretPhoneInput(targetPhone);
  if (read.status === 'needs_country') {
    await reply(
      ctx,
      'Phone number needs a country code.\nExample: credit 2347080437343 0.01'
    );
    return;
  }
  const key = read.status === 'e164' ? read.e164 : normalizePhoneNumber(targetPhone);
  if (key.length < 6) {
    await reply(
      ctx,
      'Invalid id. Use digits with country code.\nExample: credit 2347080437343 0.01'
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
  handleCredit,
};
