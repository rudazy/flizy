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
 * Dependencies go one way. This imports runtime, config, the chat layer and
 * the account-resolution module; nothing here imports router, which is what
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

const crypto = require('crypto');
const { ethers } = require('ethers');
const { config } = require('../config');
const {
  linkLockState,
  recordFailedLinkAttempt,
  clearLinkAttempts,
} = require('../linkAttempts');
const { maskPhone } = require('../phone');
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
const { reply, cmd, isAdminUser, formatEth } = require('../commands/chat');
const { USER_COLS } = require('../commands/account');

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

/**
 * Length floors for the setup secret.
 *
 * Length is a poor proxy for entropy: a random 16 characters is about 95 bits
 * and unguessable, while a memorable 30 may be worth almost nothing. So the hard
 * floor only catches secrets that are trivially short, and the real defence is
 * the attempt lockout below, which bounds guessing whatever the secret is.
 *
 * A floor set above what deployed secrets actually use would turn a working
 * operator command into an outage, so the floor sits where it refuses the
 * indefensible and the advised length only warns.
 */
const ADMIN_SECRET_MIN_LENGTH = 16;
const ADMIN_SECRET_ADVISED_LENGTH = 32;

/** Said when the attempt counter is unavailable. Deliberately says nothing about the secret. */
const ADMIN_UNAVAILABLE_REPLY = 'Admin setup is unavailable right now. Try again later.';

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Digested first so unequal lengths can be compared at all, and so the length
 * of the real secret is not observable either.
 */
function secretsMatch(given, expected) {
  const a = crypto.createHash('sha256').update(String(given ?? ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Promote the caller to admin, on proof of the setup secret.
 *
 * THIS IS THE MOST VALUABLE COMMAND IN THE PRODUCT, so it is worth being blunt
 * about what admin buys. lib/engine/policy.js exempts an admin from three
 * separate controls: the session unlock requirement (evaluateSendPolicy and
 * evaluateSwapPolicy), and in evaluateSendPolicy the daily send limit and the
 * credit check. After this command succeeds the only thing still standing
 * between the caller and the money is the trusted-destination list and its 24
 * hour hold.
 *
 * So the secret is compared in constant time, every attempt is logged, and
 * guesses run into the same lockout ladder as the other secrets this product
 * takes over chat (a link code, an unlock PIN).
 *
 * The counter is the link-attempt counter, deliberately shared rather than a
 * fourth table. It is keyed on (channel, external_id), which is exactly the
 * right key here, and the question both commands ask is the same one: is this
 * chat guessing a secret? Sharing it means an attacker probing both gets locked
 * out sooner, and the only cost is that somebody who mistyped a link code has
 * to wait before claiming admin, which is a combination worth nothing to defend.
 *
 * Unlike linking, this fails CLOSED. A link code has 50 bits of entropy behind
 * the counter; this secret may have far less, so the counter is the defence. If
 * the lock state cannot be read, or the attempt cannot be counted, the attempt
 * is refused before the secret is compared. The attempt is counted before the
 * comparison for the same reason: a store that reads but cannot write would
 * otherwise never lock anybody out.
 */
async function handleClaimAdmin(ctx, user, secret) {
  const expected = config.adminSetupSecret;
  const channel = ctx.channel;
  const externalId = ctx.externalId;

  // Above the comparison on purpose, the same ordering the link and PIN paths
  // use: a locked-out guesser must not learn whether their guess was close, or
  // even whether the feature is configured.
  const lock = await linkLockState(channel, externalId);
  if (lock.degraded) {
    console.error(
      `[admin] claimadmin refused, attempt counter unreadable channel=${channel} id=${maskPhone(externalId)}`
    );
    await reply(ctx, ADMIN_UNAVAILABLE_REPLY);
    return;
  }
  if (lock.locked) {
    console.warn(
      `[admin] claimadmin refused, locked out channel=${channel} id=${maskPhone(externalId)} until=${lock.until}`
    );
    await reply(
      ctx,
      [
        'Too many wrong secrets from this chat.',
        `Try again in about ${lock.retryAfterText || 'a while'}.`,
      ].join('\n')
    );
    return;
  }

  if (!expected || expected === 'changeme') {
    await reply(
      ctx,
      'Admin setup is not configured.\nSet ADMIN_SETUP_SECRET in .env (not "changeme"), restart, then:\nclaimadmin your-secret'
    );
    return;
  }

  if (String(expected).length < ADMIN_SECRET_ADVISED_LENGTH) {
    // Not fatal, but said out loud every time, because nobody re-reads the
    // config file and this is the command that removes three spend controls.
    console.warn(
      `[admin] ADMIN_SETUP_SECRET is ${String(expected).length} characters; ${ADMIN_SECRET_ADVISED_LENGTH}+ random characters is advised`
    );
  }

  // A trivially short secret makes the lockout the only defence. Refusing is the
  // honest answer: an operator who set one needs to know, and until they fix it
  // the command grants nothing.
  if (String(expected).length < ADMIN_SECRET_MIN_LENGTH) {
    console.error(
      `[admin] ADMIN_SETUP_SECRET is shorter than ${ADMIN_SECRET_MIN_LENGTH} characters; claimadmin is refusing every attempt`
    );
    await reply(
      ctx,
      [
        'Admin setup is not usable.',
        `ADMIN_SETUP_SECRET must be at least ${ADMIN_SECRET_MIN_LENGTH} characters.`,
        'Set a longer one, restart, then try again.',
      ].join('\n')
    );
    return;
  }

  // Counted as a failure up front and cleared on a match, so a guess that
  // cannot be counted is never compared.
  const counted = await recordFailedLinkAttempt(channel, externalId);
  if (!counted.recorded) {
    console.error(
      `[admin] claimadmin refused, attempt could not be counted channel=${channel} id=${maskPhone(externalId)}`
    );
    await reply(ctx, ADMIN_UNAVAILABLE_REPLY);
    return;
  }

  if (!secretsMatch(secret, expected)) {
    // Logged, because an invisible grind against this command is the one nobody
    // would notice until the money had moved.
    console.warn(
      `[admin] claimadmin failed channel=${channel} id=${maskPhone(externalId)} attempts=${counted.attempts}`
    );
    const tail =
      counted.lockedForMs > 0
        ? `\nToo many attempts. Wait about ${counted.retryAfterText} before trying again.`
        : counted.attemptsLeft != null && counted.attemptsLeft <= 2
          ? `\nTries left before a timeout: ${counted.attemptsLeft}`
          : '';
    await reply(ctx, `Invalid setup secret.${tail}`);
    return;
  }

  // A correct secret clears the counter, the same rule as a correct link code
  // and a correct PIN.
  await clearLinkAttempts(channel, externalId);

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

  // The promotion is logged: this is the one state change in the product that
  // removes three spend controls at once, so it belongs in the journal whether
  // or not anybody is watching that day.
  console.warn(
    `[admin] promoted to admin channel=${channel} id=${maskPhone(externalId)} user=${user.id}`
  );

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
  handleClaimAdmin,
  handleCredit,
};
