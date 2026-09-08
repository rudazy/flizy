/**
 * Flizy command router — channel agnostic.
 *
 * Clients (WhatsApp, Telegram) turn a chat message into a ctx and hand the raw
 * text here. Everything below this line is the same product on every channel:
 * the same Intent, the same Policy, the same Plan, the same receipts.
 *
 * A client NEVER decides money rules. It only supplies:
 *   ctx.channel      'whatsapp' | 'telegram'
 *   ctx.externalId   the chat identity on that channel
 *   ctx.key          `${channel}:${externalId}` (pending flows, logs)
 *   ctx.reply        (text, opts) => Promise   opts.buttons is optional
 *   ctx.resolveVerifiedPhone  optional, returns a channel-verified phone
 *   ctx.raw          the underlying message object (never used for logic)
 */

const { ethers } = require('ethers');
const { randomUUID } = require('node:crypto');

const { config } = require('./config');
const { chain, supabase, provider, opsWallet, escrowWallet, txUrl } = require('./runtime');
const { publicErrorMessage, displaySafeLabel } = require('./sanitize');
const {
  isPayCodeFormat,
  resolveFlizyPayDestination,
  hasPaidMerchantBefore,
  isSavedMerchant,
} = require('./payCode');
const { addTrusted } = require('./trusted');
const { tryAccountTxLock, releaseAccountTxLock } = require('./accountTxLock');
const {
  CHANNELS,
  normalizeChannel,
  getAccountByIdentity,
  getOrCreateAccountForIdentity,
  consumeLinkCode,
  setIdentityPhone,
  findAccountIdByPhone,
  listIdentitiesForAccount,
} = require('./identity');
const {
  normalizePhoneNumber,
  isPlausiblePhone,
  claimMatchKeysForAccount,
  maskPhone,
} = require('./phone');
const { maskLinkCode } = require('./linkCode');
const { stripFlizyPrefix, parseUnlockCommand, parseLockCommand } = require('./prefix');
const { getInviteSummary } = require('./invite');
const {
  isSessionHardLocked,
  unlockWithPin,
  touchSession,
  lockSession,
  getSession,
} = require('./session');
const { normalizeWaHint, formatClaimAmount } = require('./claims');
const { unlinkChannelIdentity, BindError } = require('./channelBind');
const { getSupabase } = require('./supabase');
const { formatClaimHistoryLabel } = require('./claimHistoryLabel');
const { ensureAgentWallet, getAgentSigner } = require('./agentWallet');
const { planGasBufferEth } = require('./gatorExecute');
const { getWalletHoldings, formatHoldingsMessage } = require('./holdings');
const {
  createSendIntent,
  createSwapIntent,
  evaluateSendPolicy,
  evaluateSwapPolicy,
  buildSendPlan,
  formatPlanPreview,
  assertPlanFunded,
  buildSwapPlan,
  formatSwapPlanPreview,
  executeNativeSend,
  executeClaimHold,
  executeSwapPlan,
  formatSendPending,
  formatSendReceipt,
  formatSwapReceipt,
} = require('./engine');
const {
  createPot,
  getPotByCode,
  getPotById,
  formatPotContributionNotice,
  listPotsForAccount,
  potTotals,
  listPotContributions,
  closePot,
  renamePot,
  potProgressLine,
  formatPotsMenu,
  formatPotDetail,
  POT_STATUS,
} = require('./pots');
const {
  createPaymentRequest,
  accountRecipient,
  listOutgoingRequests,
  listIncomingRequests,
  beginRequestProcessing,
  releaseRequestProcessing,
  cancelPaymentRequest,
  declinePaymentRequest,
  markRequestPaid,
  getPaymentRequestById,
  summarizeBillsForAccount,
  billLines,
  remindRequest,
  formatRequestReminderNotice,
  requestRecipientFromRow,
  requestRemainingEth,
  requestPayerLabel,
  formatRequestsMenu,
  formatRequestPaidNotice,
  formatRequestDeclinedNotice,
} = require('./paymentRequests');
const {
  getDexConfig,
  resolveToken,
  tokenLabel,
  resolveListedSendAsset,
  quoteSwap,
  quoteExactOut,
  getFlzPrice,
  getTokenOverview,
} = require('./dex');
const {
  resolveListedNft,
  normalizeNftTokenId,
  nftOwnedBy,
  nftClaimedBy,
  executeNftMint,
} = require('./listedNfts');
const { canonicalizeCommand } = require('./commandAliases');
const { phoneRecipient, emailRecipient } = require('./claimRecipient');
const { resolvePayRef } = require('./payCode');
const { unsupportedCurrencyCommand, looksLikeNonEthAmount } = require('./commands/amount');
const { loadSettledHistory } = require('./history');
const { listPendingClaimsForAccount } = require('./pendingClaims');
const { lookupNamedAssetHoldings } = require('./holdings');
const { notifyPhone, notifyAccount, formatReceivedNotice } = require('./notify');

// ---------------------------------------------------------------------------
// Pending flows -- lib/commands/pending.js
//
// In-memory, keyed by ctx.key. Moved behind one boundary so handler groups can
// leave this file, and so making the state durable later is a change in that
// module rather than in every handler that asks a question.
// ---------------------------------------------------------------------------

const {
  PENDING_TTL_MS,
  pruneExpiredPending,
  discardPendingFlows,
  pendingFlowFor,
  pendingSends,
  pendingWalletAdds,
  pendingClaimMenus,
  pendingUnlocks,
  pendingChoices,
  pendingNamedSends,
  pendingMultiNftSends,
  pendingPayAsks,
  pendingMerchantSaves,
  pendingPayCodes,
  pendingPotPays,
  pendingTokenBuys,
} = require('./commands/pending');

// ---------------------------------------------------------------------------
// Parsers -- lib/commands/parse.js
//
// Pure text-to-intent functions, extracted so this file holds dispatch and
// handlers rather than both. Re-exported below unchanged: tests and the other
// adapters import them from here exactly as they always have.
// ---------------------------------------------------------------------------

const {
  LISTED_SEND_SYMBOLS,
  NAMED_ASSET_SHAPES,
  SEND_PLATFORM_RE,
  firstDuplicateId,
  isBalanceCommand,
  isCancelCommand,
  isDeclineCommand,
  parseDeclineCommand,
  parseRemindCommand,
  isConfirmCommand,
  isContactsListCommand,
  isDepositCommand,
  isEscrowCommand,
  isFlizyCommandBody,
  isHelpCommand,
  isHistoryCommand,
  isHowCommand,
  isInviteCommand,
  isMeCommand,
  isMerchantSaveReply,
  isNativeSendAsset,
  isOneOf,
  isPhoneShareCommand,
  isPoolCommand,
  isUsersCommand,
  isValidTrustedName,
  normalizePlatformName,
  normalizeSendAsset,
  parseAddWalletCommand,
  parseBareAmount,
  parseBareContract,
  parseBarePayCode,
  parseCancelClaimsCommand,
  parseClaimAdminCommand,
  parseClaimsListCommand,
  parseCreditCommand,
  parseLinkCommand,
  parseMintCommand,
  parseNftSendCommand,
  parseNftTokenIdList,
  parsePayAskCommand,
  parseRemoveContactCommand,
  parseRequestCommand,
  parseCollectCommand,
  parsePotsListCommand,
  parsePotCommand,
  parsePayPotCommand,
  parsePayPotNoAmountCommand,
  parseClosePotCommand,
  parseRenamePotCommand,
  parseSplitCommand,
  parseRequestsCommand,
  parseSaveContactCommand,
  parseSendCommand,
  parseSendNamedAssetCommand,
  parseSwapCommand,
  parseUnlinkCommand,
} = require('./commands/parse');

/**
 * The answer to whatever question is currently open on this chat, or null.
 *
 * Two gates decide whether a bare reply counts as input: isFlizyCommand, which
 * is whether the bot wakes at all on WhatsApp, and normalizeInput, which is
 * whether the text reaches a handler. Each used to keep its own list, and they
 * disagreed three separate times -- a bare "save", a prefixed "flizy save", and
 * an amount after a pasted pay code. Every symptom had the same shape: it
 * worked on Telegram, which has no wake gate, and did nothing at all on
 * WhatsApp, silently, with no error to notice.
 *
 * So both gates ask this one function now. A single predicate cannot disagree
 * with itself, and a new flow is wired up by adding one line here rather than
 * by remembering two places.
 *
 * The prefix is optional on purpose. WhatsApp needs "flizy 5 flz" and Telegram
 * takes "5 flz"; they are the same answer to the same question, so it is
 * stripped before anything is matched.
 *
 * Deliberately narrow: only while a question is open, and only the shapes that
 * answer it. An open question must never turn ordinary WhatsApp chatter into
 * commands.
 *
 * @returns {string|null} the answer with any prefix removed, or null
 */
function pendingReply(ctx, raw) {
  const flow = pendingFlowFor(ctx.key);
  // An open pay prompt takes a bare amount as a part payment. Without it here,
  // that answer never woke the bot on either channel: the feature routed and
  // was tested, and no user could have reached it. Same shape of gap as the
  // currency work -- whatever routes must also wake.
  const payPrompt = payRequestPrompt(ctx) || flow.potPay;
  if (!flow.merchantSave && !flow.payCode && !flow.tokenBuy && !payPrompt) return null;

  const body = stripFlizyPrefix(String(raw || ''), { requirePrefix: false }).body.trim();
  if (!body) return null;

  if (flow.merchantSave && isMerchantSaveReply(body)) return body.toLowerCase();
  if (flow.payCode && (parseBarePayCode(body) || parseBareAmount(body))) return body;
  if (flow.tokenBuy && (parseBareContract(body) || parseBareAmount(body))) return body;
  if (payPrompt && parseBareAmount(body)) return body;
  return null;
}

/**
 * True only while a single request is sitting on a confirm prompt.
 *
 * Narrower than flow.claimMenu on purpose: a bare amount answers "pay this
 * request?" and answers nothing in the cancel or claim menus, so waking for one
 * there would turn ordinary chatter into a command for no benefit.
 */
function payRequestPrompt(ctx) {
  const menu = pendingClaimMenus.get(ctx.key);
  return Boolean(menu && menu.mode === 'pay_request' && menu.awaitConfirmId);
}
/**
 * Raw chat text that should wake the bot.
 * WhatsApp normally requires the "flizy" prefix; bare confirm/cancel always work
 * so a pending plan is never stuck. Telegram uses /commands.
 */
function isFlizyCommand(ctx, text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (isConfirmCommand(raw) || isCancelCommand(raw) || isDeclineCommand(raw)) return true;
  if (parseDeclineCommand(raw)) return true;
  if (pendingReply(ctx, raw)) return true;
  if (/^flizy\b/i.test(raw)) {
    const stripped = stripFlizyPrefix(raw, { requirePrefix: true });
    return stripped.ok && (stripped.body === '' || isFlizyCommandBody(stripped.body));
  }
  if (normalizeChannel(ctx.channel) === CHANNELS.TELEGRAM) {
    if (raw.startsWith('/')) return true;
    return isFlizyCommandBody(raw);
  }
  if (config.requireFlizyPrefix) return false;
  return isFlizyCommandBody(raw);
}

/**
 * When hard-locked, only unlock (and the unlock reply) may run.
 * Link stays allowed so a locked user can re-bind if needed.
 */
function isAllowedWhenLocked(body) {
  return (
    Boolean(parseUnlockCommand(body)) ||
    Boolean(parseLinkCommand(body)) ||
    parseLockCommand(body)
  );
}

/**
 * What to say when unlock did not work.
 *
 * Three cases, one place, because both the one-shot and the interactive unlock
 * path render it. A locked-out user always gets the site route out, since
 * proving the password there is what clears the block.
 *
 * @param {object} ctx
 * @param {object} res result from unlockWithPin
 */
function unlockFailureText(ctx, res) {
  const resetHint = [
    `Forgot it? Set a new PIN with your account password: ${config.siteUrl}/dashboard/account`,
    'That clears the block immediately.',
  ];

  if (res.reason === 'pin_locked') {
    return [
      'Too many wrong attempts.',
      `Unlock is blocked on this ${channelName(ctx)} for about ${res.retryAfterText}.`,
      '',
      ...resetHint,
    ].join('\n');
  }

  if (res.lockedForMs > 0) {
    return [
      'Wrong password or PIN, once too often.',
      `Unlock is now blocked on this ${channelName(ctx)} for about ${res.retryAfterText}.`,
      '',
      ...resetHint,
    ].join('\n');
  }

  const lines = [
    'Unlock failed. Wrong password or PIN.',
    'Use your site login password, or the unlock PIN from Account.',
  ];
  if (res.attemptsLeft === 1) {
    lines.push('One more wrong attempt blocks unlock here for a while.');
  }
  lines.push(`Try again: ${cmd(ctx, 'unlock')}`);
  return lines.join('\n');
}

/**
 * Normalize raw chat text into a command body.
 * @returns {{ text: string, hadPrefix: boolean } | null} null = ignore silently
 */
function normalizeInput(ctx, rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;

  const flow = pendingFlowFor(ctx.key);
  // choice included so a bare "1" answers the trade prompt on WhatsApp, where
  // there are no buttons and the flizy prefix would otherwise be required.
  const midFlow =
    flow.walletAdd || flow.claimMenu || flow.unlock || flow.choice || flow.namedSend;
  const telegram = normalizeChannel(ctx.channel) === CHANNELS.TELEGRAM;

  // A pending unlock reads the next message as a secret; a pending wallet add
  // reads it as a label the user picked. Neither is a command, so neither gets
  // canonicalized -- rewriting a password is how an unlock silently fails for
  // the one person whose password happens to look like a command.
  const freeform = flow.unlock || flow.walletAdd;
  const canon = (body) => (freeform ? body : canonicalizeCommand(body));

  if (isConfirmCommand(raw) || isCancelCommand(raw)) {
    return { text: raw.toLowerCase(), hadPrefix: false };
  }

  // Whatever question is open answers here, on either channel, prefixed or
  // not. The same predicate decides whether the bot wakes at all, so the two
  // can no longer disagree -- see pendingReply.
  const answer = pendingReply(ctx, raw);
  if (answer) return { text: answer, hadPrefix: false };

  if (telegram && raw.startsWith('/')) {
    // /send@FlizyBot 0.01 to john  →  send 0.01 to john
    const body = raw.slice(1).replace(/^([a-zA-Z_]+)@[\w_]+/, '$1').trim();
    const start = body.match(/^start(?:\s+(\S+))?$/i);
    if (start) {
      return { text: start[1] ? `link ${start[1]}` : 'help', hadPrefix: true };
    }
    return { text: body === '' ? 'help' : canon(body), hadPrefix: true };
  }

  const stripped = stripFlizyPrefix(raw, {
    requirePrefix: telegram ? false : config.requireFlizyPrefix,
  });

  if (!stripped.ok) {
    // No prefix and prefix required: only mid-flow bare replies get through
    return midFlow ? { text: raw, hadPrefix: false } : null;
  }

  if (stripped.hadPrefix) {
    return {
      text: stripped.body === '' ? 'help' : canon(stripped.body),
      hadPrefix: true,
    };
  }

  // Bare text: a command body, or mid-flow input (wallet name, PIN, menu pick).
  // Mid-flow replies below are deliberately NOT canonicalized: a wallet label or
  // a PIN is data the user chose, never a command to be rewritten.
  if (isFlizyCommandBody(stripped.body)) {
    return { text: canon(stripped.body), hadPrefix: false };
  }
  if (midFlow) {
    return { text: raw, hadPrefix: false };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers -- lib/commands/chat.js
//
// Rendering and addressing, moved out ahead of the handlers: reply() and cmd()
// are used several hundred times between them, so they had to stop living here
// before any handler could move without importing router back.
// ---------------------------------------------------------------------------

const {
  formatEth,
  shortAddress,
  isTelegram,
  cmd,
  withFundHint,
  channelName,
  transferKey,
  isAdminUser,
  reply,
  confirmButtons,
  MAX_NFT_PICKS,
  numberButtons,
} = require('./commands/chat');

// ---------------------------------------------------------------------------
// Account resolution -- lib/commands/account.js
//
// Who is on this chat: the site account, the legacy users row, a display
// name. Moved behind one boundary so a handler group that needs a linked
// account can leave this file without importing it back.
// ---------------------------------------------------------------------------

const {
  resolveLegacyUser,
  resolveLinkedSiteAccount,
  requireLinkedSite,
  actorSessionFlags,
  resolveClaimIdentity,
  senderLabel,
} = require('./commands/account');

// ---------------------------------------------------------------------------
// Contacts (chat address book; the site trusted list is the policy source)
// ---------------------------------------------------------------------------

/** Every chat id this account owns, so an address book is shared across channels. */
async function ownerKeysForAccount(ctx, accountId) {
  const keys = new Set([ctx.externalId]);
  if (accountId) {
    const { data } = await supabase
      .from('channel_identities')
      .select('external_id')
      .eq('account_id', accountId);
    for (const row of data || []) {
      if (row.external_id) keys.add(row.external_id);
    }
  }
  return [...keys];
}

/**
 * Resolve 0x... or a name from:
 * 1) chat contacts saved by this account (any channel)
 * 2) site trusted_addresses.label (dashboard)
 */
async function resolveSendTarget(ctx, toRaw, isAddress, accountId) {
  if (isAddress) {
    if (!ethers.isAddress(toRaw)) return { error: 'Invalid address.' };
    return { address: ethers.getAddress(toRaw), label: null };
  }

  const alias = String(toRaw).toLowerCase();
  const owners = await ownerKeysForAccount(ctx, accountId);

  const { data: contacts, error: cErr } = await supabase
    .from('contacts')
    .select('alias, address, owner_phone')
    .in('owner_phone', owners)
    .eq('alias', alias)
    .limit(1);
  if (cErr) return { error: `Contact lookup failed: ${cErr.message}` };

  const contact = contacts && contacts.length ? contacts[0] : null;
  if (contact && ethers.isAddress(contact.address)) {
    return { address: ethers.getAddress(contact.address), label: contact.alias };
  }

  if (accountId) {
    const { data: trustedRows, error: tErr } = await supabase
      .from('trusted_addresses')
      .select('address, label')
      .eq('account_id', accountId);
    if (tErr) return { error: `Trusted lookup failed: ${tErr.message}` };

    const match = (trustedRows || []).find(
      (r) => String(r.label || '').trim().toLowerCase() === alias
    );
    if (match && ethers.isAddress(match.address)) {
      return { address: ethers.getAddress(match.address), label: match.label || alias };
    }
  }

  // Leading with "go save an address" taught people that addresses are
  // mandatory, which is the opposite of how Flizy works. The zero-setup routes
  // come first; saving a name is the fallback for a raw address you already have.
  return {
    error: [
      `No saved name "${alias}".`,
      '',
      'You do not need their address. Send to them directly:',
      `  ${cmd(ctx, 'send 0.01 to 2348012345678')}   a phone`,
      `  ${cmd(ctx, `send 0.01 to ${alias}@email.com`)}   an email`,
      `  ${cmd(ctx, `send 0.01 to @${alias} on telegram`)}   a Telegram user`,
      'Flizy holds it until they claim, and makes their wallet then.',
      '',
      `Or save an address as "${alias}": ${cmd(ctx, `save ${alias} 0xTheirAddress`)}`,
      `Saved names: ${cmd(ctx, 'contacts')}`,
    ].join('\n'),
  };
}

async function saveContact(user, ownerKey, alias, address) {
  if (!ethers.isAddress(address)) {
    throw new Error('Invalid address. Use 0x + 40 hex characters.');
  }
  const checksum = ethers.getAddress(address);
  const { data, error } = await supabase
    .from('contacts')
    .upsert(
      {
        user_id: user.id,
        owner_phone: ownerKey,
        alias: alias.toLowerCase(),
        address: checksum,
      },
      { onConflict: 'owner_phone,alias' }
    )
    .select('alias, address')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function removeContact(ownerKeys, alias) {
  const { data, error } = await supabase
    .from('contacts')
    .delete()
    .in('owner_phone', ownerKeys)
    .eq('alias', alias.toLowerCase())
    .select('alias')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function listContacts(ownerKeys) {
  const { data, error } = await supabase
    .from('contacts')
    .select('alias, address')
    .in('owner_phone', ownerKeys)
    .order('alias', { ascending: true })
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

function howOthersUseText(ctx) {
  if (isTelegram(ctx)) {
    return [
      'How others use Flizy',
      '',
      '1. Share this Telegram bot with a friend.',
      '2. They open the bot and press Start.',
      '3. They create an account on the site and link it:',
      '     /link CODE',
      '4. They send from Telegram:',
      '     /send 0.001 to nald',
      '     confirm',
      '',
      'Trusted names are managed on the site only.',
      `Site: ${config.siteUrl}`,
    ].join('\n');
  }

  const numberLine = config.botWhatsAppNumber
    ? `Bot number: +${config.botWhatsAppNumber}`
    : 'Bot number: the WhatsApp that linked this bot (see terminal on start)';

  return [
    'How others use Flizy',
    '',
    '1. Share the bot WhatsApp number with friends.',
    `   ${numberLine}`,
    '2. They open WhatsApp and message that number (not a group).',
    '3. First message auto-registers them.',
    '4. They send from WhatsApp (no admin step):',
    '     flizy send 0.001 to nald',
    '     flizy confirm',
    '',
    'Trusted names are managed on the site only.',
    'Only message the Flizy bot number (or Message yourself).',
  ].join('\n');
}

/**
 * Everyday help in chat — short Web2 list only.
 * Full command list: site /docs. No chain/gas/RPC here.
 */
function helpText(ctx) {
  const p = (body) => cmd(ctx, body);
  const how = isTelegram(ctx)
    ? 'Type a command with / or the same words.'
    : 'Start each command with: flizy';

  return [
    'Flizy — send money like a message.',
    '',
    how,
    '',
    'PAYMENTS — no address needed, Flizy holds it until they claim',
    `  ${p('send 0.01 to 2348012345678')}   a phone`,
    `  ${p('send 0.01 to friend@email.com')}   an email`,
    `  ${p('send 0.01 to @user on telegram')}   a Telegram user`,
    `  ${p('send 10 FLZ to @user on telegram')}   a listed token, same hold`,
    `  ${p('send 0.01 to john')}   a name you saved`,
    `  ${p('pay john 0.01')}   same thing (send, pay, transfer, give)`,
    `  ${p('request 0.01 from 2348012345678')}   ask someone for money`,
    `  ${p('claim')}   receive money held for you`,
    '  confirm / cancel   yes go ahead, or stop',
    '',
    'SPLIT & COLLECT',
    `  ${p('split 30 with @ada @kemi')}   one bill, a request each`,
    `  ${p('collect 5 for rent')}   a named pot people pay into`,
    `  ${p('requests')}   who has paid, who has not`,
    `  ${p('remind')}   nudge whoever still owes`,
    '',
    'NFTS',
    `  ${p('send giwaforge to you@email.com')}   pick one you hold`,
    `  ${p('send 2 giwaforge to @bob on telegram')}   send two, one confirm each`,
    `  ${p('nft send giwaforge 21 to @bob on telegram')}   by token id`,
    `  ${p('mint 1 giwaforge')}   one test NFT per wallet`,
    '',
    'WALLET',
    `  ${p('balance')}   what you have`,
    `  ${p('deposit')}   how to add funds`,
    `  ${p('history')}   recent activity`,
    '',
    'SETTINGS',
    `  ${p('me')}   your linked account`,
    `  ${p('link CODE')}   connect your site account`,
    `  ${p('unlink')}   disconnect this chat from Flizy`,
    `  ${p('lock')} or ${p('unlock')}   freeze or open this chat`,
    '',
    `Visit ${config.siteUrl}/docs for the full Flizy command list.`,
  ].join('\n');
}

/**
 * What a brand-new chat is told to do first.
 *
 * This used to open with `send 0.001 to @friend on telegram` for everybody. A
 * brand-new account has an empty wallet and usually no linked site account, so
 * the first instruction Flizy gave was the one thing that could not work: it
 * went straight into the funding wall, or into "link your site account first".
 * Leading with an action that always fails is the opposite of the goal here,
 * which is a short time to the first send that actually succeeds.
 *
 * So the opening line is whatever this person can do **next**, in the order the
 * money has to arrive:
 *
 *   not linked      -> link, because nothing else is reachable without it
 *   money waiting   -> claim, the fastest route to a real balance
 *   has funds       -> send, the thing the product is for
 *   linked, empty   -> deposit
 *
 * The rest of the commands still follow, so nothing is hidden from someone who
 * already knows what they want.
 *
 * @param {object} state from welcomeState; all-null is treated as "unknown",
 *   which falls back to the linked-and-empty wording rather than guessing.
 */
function welcomeText(ctx, user, state = {}) {
  const lines = ['Welcome to Flizy', ''];

  if (state.linked === false) {
    lines.push('Connect your Flizy account to this chat first.');
    lines.push('');
    lines.push(`Open ${config.siteUrl}/dashboard, generate a code, then:`);
    lines.push(`  ${cmd(ctx, 'link CODE')}`);
  } else if (state.waitingCount > 0) {
    const amount = state.waitingEth ? `${formatEth(state.waitingEth)} ETH` : 'money';
    lines.push(`You have ${amount} waiting to be collected.`);
    lines.push('');
    lines.push(`  ${cmd(ctx, 'claim')}     collect it`);
  } else if (state.hasFunds) {
    lines.push('Send money like a message — to a phone, email, Telegram, GitHub, or a name you saved.');
    lines.push('');
    lines.push(`  ${cmd(ctx, 'send 0.001 to @friend on telegram')}   no address needed`);
    lines.push(`  ${cmd(ctx, 'send 0.001 to 2348012345678')}   or a phone`);
  } else {
    lines.push('Add funds first, then you can send to a phone, email or Telegram handle.');
    lines.push('');
    lines.push(`  ${cmd(ctx, 'deposit')}    how to add funds`);
    lines.push(`  ${cmd(ctx, 'balance')}    what you have`);
  }

  lines.push('');
  lines.push(
    isTelegram(ctx)
      ? 'Then (slash commands work too):'
      : 'Then, on WhatsApp, prefix with flizy:'
  );
  lines.push(`  ${cmd(ctx, 'help')}     short guide`);
  lines.push(`  ${cmd(ctx, 'lock')}     freeze this chat`);
  lines.push('');
  lines.push(`Dashboard: ${config.siteUrl}/dashboard`);
  lines.push(`All commands: ${config.siteUrl}/docs`);
  return lines.join('\n');
}

/**
 * How long the greeting will wait on the chain before answering without it.
 *
 * A try/catch does not save you from a hang, and ethers' JsonRpcProvider does
 * not fail fast: when the node is unreachable it logs "failed to detect network"
 * and retries every second, forever. Without this bound, a slow or down RPC
 * would stall the first message every new user sends -- the greeting itself,
 * before they have done anything. That is a worse failure than the one this
 * whole change set out to fix, and it is exactly the chain leaking into the
 * product that philosophy lock 2 forbids.
 *
 * Missing the deadline is not an error. It means "unknown", and unknown reads
 * as the deposit wording, which is right for almost every genuinely new account.
 */
const WELCOME_CHAIN_DEADLINE_MS = 1200;

/** Sentinel so a legitimately undefined result is not mistaken for a timeout. */
const TIMED_OUT = Symbol('timed out');

/**
 * Resolve with the promise, or with TIMED_OUT once the deadline passes.
 *
 * The loser keeps running; nothing here can cancel an in-flight RPC. That is
 * the limit worth understanding before relying on this: racing a deadline
 * bounds how long the *caller* waits, and nothing else. Work still in flight
 * against a provider that retries forever will keep the process alive whatever
 * this returns, which is why welcomeState uses the shared runtime provider
 * rather than letting a helper construct one of its own.
 *
 * The timer is unref'd so the deadline itself never holds the process open.
 */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Read just enough to order the welcome, and never let it fail.
 *
 * A greeting must not depend on an RPC being up, and "guarded" has to mean
 * bounded as well as caught: see WELCOME_CHAIN_DEADLINE_MS. Every lookup here
 * degrades to `null` on failure or timeout, which welcomeText reads as
 * "unknown" and answers with the deposit wording -- correct for almost every
 * genuinely new account, and never an error page or a stall.
 *
 * The cheap checks run first and the chain call runs last, so the most common
 * case costs one query. That ordering is deliberate: when this was written most
 * accounts had no linked chat at all, and those never reach the chain call.
 */
async function welcomeState(ctx, account) {
  const state = { linked: null, waitingCount: 0, waitingEth: null, hasFunds: null };

  let acc = null;
  try {
    acc = await resolveLinkedSiteAccount(ctx, account);
  } catch (err) {
    console.warn('welcome state, link lookup:', publicErrorMessage(err));
    return state;
  }
  state.linked = Boolean(acc?.id);
  if (!state.linked) return state;

  try {
    const waiting = await listPendingClaimsForAccount(acc.id);
    state.waitingCount = waiting.length;
    state.waitingEth = waiting.reduce((sum, c) => sum + Number(c.amount_eth || 0), 0) || null;
  } catch (err) {
    console.warn('welcome state, pending claims:', publicErrorMessage(err));
  }
  if (state.waitingCount > 0) return state;

  try {
    if (acc.agent_wallet_address) {
      // The shared runtime provider, never getWalletHoldings: that builds its
      // own JsonRpcProvider, and an unreachable node leaves it retrying on a
      // handle nothing closes. The wait is bounded below, but a second provider
      // would keep the process alive regardless of who is still waiting on it.
      const wei = await withDeadline(
        provider.getBalance(ethers.getAddress(acc.agent_wallet_address)),
        WELCOME_CHAIN_DEADLINE_MS
      );
      state.hasFunds = wei === TIMED_OUT ? null : wei > 0n;
    }
  } catch (err) {
    console.warn('welcome state, holdings:', publicErrorMessage(err));
  }
  return state;
}

/** Command list for a channel that shows a menu (Telegram setMyCommands). */
function commandMenu() {
  // Telegram's menu is a flat list — setMyCommands takes no categories and no
  // nesting. Grouping is faked the only two ways the protocol allows: the order
  // and a category word at the front of each description. Anything dropped from
  // here still works when typed; the site docs carry the full list.
  return [
    { command: 'help', description: 'Start here — the short guide' },

    { command: 'send', description: 'Payments — pay a phone, email, Telegram, or saved name' },
    { command: 'request', description: 'Payments — ask someone for money' },
    { command: 'pay', description: 'Payments — pay a request sent to you' },
    { command: 'claim', description: 'Payments — receive money held for you' },

    { command: 'split', description: 'Groups — split a bill, a request each' },
    { command: 'collect', description: 'Groups — start a named pot' },
    { command: 'pots', description: 'Groups — your pots and their totals' },
    { command: 'remind', description: 'Groups — nudge whoever still owes you' },

    { command: 'balance', description: 'Wallet — what you have' },
    { command: 'deposit', description: 'Wallet — how to add funds' },
    { command: 'history', description: 'Wallet — recent activity' },

    { command: 'buy', description: 'Trade — buy FLZ (buy 100 FLZ)' },
    { command: 'sell', description: 'Trade — sell FLZ' },
    { command: 'swap', description: 'Trade — swap tokens' },

    { command: 'me', description: 'Settings — your linked account' },
    { command: 'link', description: 'Settings — connect your site account with a code' },
    { command: 'phone', description: 'Settings — share your number for phone claims' },
    { command: 'contacts', description: 'Settings — saved names' },
    { command: 'invite', description: 'Settings — your invite link and credits' },
    { command: 'lock', description: 'Settings — freeze Flizy on this chat' },
    { command: 'unlock', description: 'Settings — unlock with PIN or password' },
  ];
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleMe(ctx, user, account) {
  try {
    const acc = await resolveLinkedSiteAccount(ctx, account);
    if (!acc) {
      await reply(
        ctx,
        [
          'Link your site account to see your permanent Flizy wallet.',
          `Site: ${config.siteUrl}/dashboard`,
          `Generate a code, then: ${cmd(ctx, 'link CODE')}`,
          '',
          `${channelName(ctx)} id: ${ctx.externalId}`,
        ].join('\n')
      );
      return;
    }

    const bound = await getAccountByIdentity(ctx.channel, ctx.externalId);
    const phone = bound?.identity?.phone_e164 || null;

    await reply(
      ctx,
      [
        'Your Flizy account',
        acc.email ? `Email: ${acc.email}` : null,
        acc.display_name ? `Name: ${acc.display_name}` : null,
        `Flizy wallet: ${acc.agent_wallet_address}`,
        `${channelName(ctx)} id: ${ctx.externalId}`,
        phone ? `Claim number: +${phone}` : `Claim number: not shared (${cmd(ctx, 'phone')})`,
        acc.email && !acc.email_verified_at
          ? ''
          : null,
        acc.email && !acc.email_verified_at
          ? 'Email is not verified yet. Chat still works. The site asks for a code first.'
          : null,
        acc.email && !acc.email_verified_at
          ? `Verify: ${config.siteUrl}/dashboard`
          : null,
        '',
        `Tip: ${cmd(ctx, 'balance')}  |  ${cmd(ctx, 'history')}`,
      ]
        .filter((line) => line !== null)
        .join('\n')
    );
  } catch (err) {
    console.error('me error:', publicErrorMessage(err));
    await reply(
      ctx,
      [
        'Your Flizy account',
        `${channelName(ctx)} id: ${ctx.externalId}`,
        `Could not load wallet. Try ${cmd(ctx, 'link CODE')} from the dashboard.`,
      ].join('\n')
    );
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

async function handleDeposit(ctx, user, account) {
  // User asked how to fund — show the receive address. Still no RPC/gas/chain-ID lecture.
  // The three faucet steps live on the Fund slide and are not repeated here.
  // Chat gives what the site cannot: the address and the balance right now.
  const lines = [
    'Add funds',
    '',
    'Money you send from chat leaves the balance linked to your Flizy account.',
    '',
  ];
  try {
    const acc = await resolveLinkedSiteAccount(ctx, account);
    if (acc?.agent_wallet_address) {
      lines.push('Your Flizy wallet (paste this on the faucet):');
      lines.push(acc.agent_wallet_address);
      const bal = await provider.getBalance(acc.agent_wallet_address);
      lines.push(`Current balance: ${formatEth(ethers.formatEther(bal))} ETH`);
      lines.push('', 'Faucet: https://faucet.giwa.io');
      lines.push(`Full steps: ${config.siteUrl}/dashboard/wallet?s=fund`);
    } else {
      lines.push(`Link your site account first: ${config.siteUrl}/dashboard`);
      lines.push(`Then: ${cmd(ctx, 'link CODE')}`);
    }
  } catch {
    lines.push(`Could not load your address. Try ${cmd(ctx, 'me')}`);
  }
  lines.push(
    '',
    'After funds arrive:',
    '  1) Add trusted people on the site (password required)',
    `  2) ${cmd(ctx, 'send 0.0001 to name')}`,
    '  3) confirm',
    '',
    `All commands: ${config.siteUrl}/docs`
  );
  await reply(ctx, lines.join('\n'));
}

/**
 * mint 1 giwaforge — one listed NFT per agent wallet.
 * New chats with no ETH: Flizy ops pays gas (claimTo).
 */
async function handleMint(ctx, user, account, parsed) {
  if (!parsed || !parsed.ticker) return;
  if (parsed.count !== 1) {
    await reply(
      ctx,
      `One per wallet.\nExample: ${cmd(ctx, `mint 1 ${parsed.ticker}`)}`
    );
    return;
  }

  if (!account?.id) {
    await reply(
      ctx,
      [
        'Link your site account first.',
        `Open ${config.siteUrl}/dashboard`,
        'Generate a code, then send:',
        cmd(ctx, 'link CODE'),
      ].join('\n')
    );
    return;
  }

  let listed;
  try {
    listed = resolveListedNft(parsed.ticker, chain.id);
  } catch (err) {
    await reply(ctx, err.message || 'Unknown collection.');
    return;
  }

  const siteAcc = await ensureAgentWallet(account.id);
  const actor = await actorSessionFlags(ctx, user, siteAcc);
  if (config.requireUnlock && siteAcc.unlock_pin_hash && !actor.sessionUnlocked && !actor.isAdmin) {
    await reply(ctx, `Session locked. Send:\n${cmd(ctx, 'unlock your-pin')}`);
    return;
  }

  const fromAddress = ethers.getAddress(siteAcc.agent_wallet_address);
  try {
    if (await nftClaimedBy(provider, listed.address, fromAddress)) {
      await reply(ctx, `This wallet already minted its one ${listed.ticker}.`);
      return;
    }
  } catch (err) {
    console.error('nft claimed check:', publicErrorMessage(err));
    await reply(ctx, 'Could not check that collection. Try again shortly.');
    return;
  }

  const plan = {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    intent: 'NFT_MINT',
    input: { ticker: listed.ticker, amount: '1' },
    createdAt: Date.now(),
    expiresAt: Date.now() + config.pendingTtlMs,
    actor: { accountId: siteAcc.id, userId: user.id },
    route: {
      kind: 'nft_mint',
      chainId: chain.chainId,
      chainName: chain.name,
      collection: listed.address,
      toAddress: fromAddress,
    },
  };
  pendingSends.set(ctx.key, { plan, createdAt: Date.now() });
  const mins = Math.max(1, Math.round(config.pendingTtlMs / 60000));
  await reply(
    ctx,
    [
      'Mint plan',
      '',
      `Collection:  ${listed.ticker}`,
      'You get:     1 NFT (one per wallet)',
      `To:          ${fromAddress}`,
      `Chain:       ${chain.name}`,
      '',
      `Reply confirm within ${mins} minutes to mint.`,
      'Or: cancel',
    ].join('\n'),
    { buttons: confirmButtons() }
  );
}

async function handleBalance(ctx, user, account) {
  try {
    const acc = await resolveLinkedSiteAccount(ctx, account);
    if (!acc) {
      await reply(
        ctx,
        [
          'Link your site account to see your permanent Flizy wallet.',
          `Site: ${config.siteUrl}/dashboard`,
          `Generate a code, then: ${cmd(ctx, 'link CODE')}`,
        ].join('\n')
      );
      return;
    }
    const credit = formatEth(acc?.balance_eth != null ? acc.balance_eth : user.balance_eth);
    let holdings = null;
    if (acc?.agent_wallet_address) {
      holdings = await getWalletHoldings(acc.agent_wallet_address, chain);
    }
    await reply(
      ctx,
      formatHoldingsMessage({
        credit,
        agentWallet: acc?.agent_wallet_address || null,
        holdings,
        showCredit: config.enforceCredit,
      })
    );
  } catch (err) {
    console.error('balance error:', publicErrorMessage(err));
    // Say it could not be read. This used to answer with `user.balance_eth`
    // under the heading "Your credit" -- a different number, from the ledger
    // that is switched off in production, shown in place of the one they asked
    // for. A wrong balance is worse than no balance.
    await reply(
      ctx,
      ['Could not read your balance right now.', 'Try again shortly.'].join('\n')
    );
  }
}

/**
 * `history` — what happened, and what is still waiting.
 *
 * The querying lives in lib/history.js because the site asks the same
 * question and the two answers have to match. What stays here is the chat
 * rendering: one line per row, terse, with the explorer link underneath.
 *
 * Waiting sits above settled rather than mixed into it. An unclaimed incoming
 * claim is not history, it is money the user still has to collect, and it used
 * not to appear in chat at all.
 */
async function handleHistory(ctx, account) {
  const accountId = account?.id || null;

  let settled = { items: [] };
  try {
    // The wallet is what finds money other people sent: transfers are keyed to
    // the sender, so the only way in from this side is the destination address.
    const acc = accountId ? await ensureAgentWallet(accountId).catch(() => null) : null;
    settled = await loadSettledHistory(supabase, accountId, {
      transferKey: transferKey(ctx),
      walletAddress: acc?.agent_wallet_address || null,
    });
  } catch (err) {
    console.error('history:', publicErrorMessage(err));
    await reply(ctx, 'Could not load history right now.');
    return;
  }

  let waiting = [];
  if (accountId) {
    try {
      waiting = await listPendingClaimsForAccount(accountId);
    } catch (err) {
      // Never fail the whole command over the waiting block: settled activity
      // is still worth showing.
      console.warn('history waiting:', publicErrorMessage(err));
    }
  }

  const lines = [];

  if (waiting.length > 0) {
    lines.push(`Waiting for you (${waiting.length}):`);
    for (const c of waiting) {
      lines.push(`  ${formatClaimHistoryLabel(c, { role: 'receiver', status: c.status })}`);
    }
    lines.push(`  Collect: ${cmd(ctx, 'claim')}`, '');
  }

  if (settled.items.length === 0) {
    if (waiting.length === 0) {
      await reply(
        ctx,
        [
          'No activity yet.',
          `Try: ${cmd(ctx, 'send 0.001 to john')}`,
          `Or: ${cmd(ctx, 'send 10 FLZ to john')}`,
          `Or: ${cmd(ctx, 'buy 0.01 FLZ')}`,
        ].join('\n')
      );
      return;
    }
    lines.push('No settled activity yet.');
    await reply(ctx, lines.join('\n'));
    return;
  }

  lines.push(`Last ${settled.items.length} activity:`);
  for (const item of settled.items) {
    if (item.source === 'claim') {
      const c = item.row;
      const role = c.from_account_id === accountId ? 'sender' : 'receiver';
      lines.push(`• ${formatClaimHistoryLabel(c, { role, status: c.status })}`);
      const tx = c.claim_tx_hash || c.refund_tx_hash || c.hold_tx_hash;
      if (tx) lines.push(`  ${txUrl(tx)}`);
      continue;
    }

    const row = item.row;
    const kind = String(row.kind || 'transfer').toLowerCase();
    const asset = String(row.asset || 'ETH').toUpperCase();
    const amt = formatEth(row.amount_eth);
    if (kind === 'swap') {
      const out =
        row.amount_secondary && row.asset_secondary
          ? ` → ${formatEth(row.amount_secondary)} ${row.asset_secondary}`
          : '';
      lines.push(`• Swap ${amt} ${asset}${out} [${row.status}]`);
    } else {
      // item.received, not row.direction: the row belongs to whoever sent it.
      const dir = item.received ? 'Received' : 'Sent';
      const arrow = item.received ? 'from' : '→';
      // On a received row, counterparty_label names the reader and row.phone is
      // the sender's own number. item.fromLabel is the only honest source.
      const dest = item.received
        ? item.fromLabel || 'someone'
        : row.counterparty_label || shortAddress(row.to_address);
      const note = row.note ? `  ${displaySafeLabel(row.note)}` : '';
      lines.push(`• ${dir} ${amt} ${asset} ${arrow} ${dest}${note} [${row.status}]`);
    }
    if (row.tx_hash) lines.push(`  ${txUrl(row.tx_hash)}`);
  }

  await reply(ctx, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Admin commands -- lib/handlers/admin.js
//
// First handler group moved out. Gated on isAdminUser, operator surface only.
// ---------------------------------------------------------------------------

const {
  handlePool,
  handleEscrow,
  handleUsers,
  handleClaimAdmin,
  handleCredit,
} = require('./handlers/admin');

// ---------------------------------------------------------------------------
// Claim handlers -- lib/handlers/claims.js
//
// Hold, notify, list, cancel, payout. handleSend and handleConfirm dispatch
// into this module. handleClaimMenuReply stays: it also pays requests.
// ---------------------------------------------------------------------------

const {
  resolveClaimListedAsset,
  resolveClaimHoldAsset,
  openClaimHold,
  handleSendEmailClaim,
  handleSendPlatformClaim,
  platformClaimLinkHowTo,
  emailClaimLinkHowTo,
  notifyClaimTarget,
  notifyClaimPlatformTarget,
  notifyClaimEmailTarget,
  handleCancelClaims,
  handleClaimsList,
  runCancelOneClaim,
  runPayoutOneClaim,
  notifyIncomingAfterLink,
} = require('./handlers/claims');

/**
 * SEND path: trusted/address on-chain OR phone/platform/email claim hold.
 * @param {string|null} [platform] e.g. 'github' for github:login targets
 * @param {boolean} [isEmail]
 */
async function handleSend(
  ctx,
  user,
  account,
  amountEth,
  toRaw,
  isAddress,
  isPhone,
  asset = 'ETH',
  platform = null,
  isEmail = false,
  note = null,
  nft = null,
  assetExplicit = true
) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  // A bare amount this large was not meant as ETH. Answer the question the
  // user actually has instead of letting policy quote them an ETH cap.
  if (!assetExplicit && looksLikeNonEthAmount(amountEth, config.bareAmountEthCeiling)) {
    await reply(
      ctx,
      [
        'Name the asset for an amount this size.',
        '',
        `  ${cmd(ctx, `send ${amountEth} flz to ${toRaw}`)}`,
        '',
        `Max per send is ${config.maxSendEth} ETH, so ${amountEth} is not an ETH amount.`,
        'Naira amounts are not supported yet.',
      ].join('\n')
    );
    return;
  }

  const sendAsset = normalizeSendAsset(asset);
  let listedOverride = null;
  if (nft && nft.ticker && nft.tokenId) {
    listedOverride = await resolveClaimHoldAsset(ctx, sendAsset, nft);
    if (!listedOverride) return;
  }

  // --- Platform: claim hold by immutable id (github / discord / x / telegram) ---
  if (
    platform === 'github' ||
    platform === 'discord' ||
    platform === 'x' ||
    platform === 'telegram'
  ) {
    await handleSendPlatformClaim(
      ctx,
      user,
      siteAcc,
      amountEth,
      toRaw,
      platform,
      sendAsset,
      listedOverride
    );
    return;
  }

  // --- Email: claim hold for registration or verified secondary email ---
  if (isEmail) {
    await handleSendEmailClaim(ctx, user, siteAcc, amountEth, toRaw, sendAsset, listedOverride);
    return;
  }

  // --- Phone: always a claim hold ---
  if (isPhone) {
    const toWa = normalizeWaHint(toRaw);
    if (!isPlausiblePhone(toWa)) {
      await reply(
        ctx,
        `Invalid phone. Use country code digits.\nExample: ${cmd(ctx, 'send 0.001 to 2348012345678')}`
      );
      return;
    }

    const mine = await resolveClaimIdentity(ctx);
    const myNumbers = [mine.waPhone, mine.waSenderId]
      .filter(Boolean)
      .map((n) => normalizeWaHint(n));
    if (myNumbers.includes(toWa)) {
      await reply(ctx, 'You cannot send a claim to your own number.');
      return;
    }

    // The check above only knows the number on THIS channel. An account with
    // WhatsApp and Telegram linked could otherwise escrow to its own other
    // number and pay gas twice to move money in a circle. Degrades open: a
    // failed lookup is not a reason to block a legitimate send.
    try {
      const targetOwner = await findAccountIdByPhone(toWa);
      if (targetOwner && targetOwner === siteAcc.id) {
        await reply(
          ctx,
          'That number is on your own Flizy account. Send to someone else, or use it from that chat.'
        );
        return;
      }
    } catch (err) {
      console.warn('self-send check:', publicErrorMessage(err));
    }

    // A number always goes to escrow, whether or not it is already on Flizy.
    // Money never lands in someone's wallet unannounced: the recipient is
    // notified the moment the hold is placed and runs "claim" to take it, and
    // until they do the sender can still cancel.
    const listed = listedOverride || (await resolveClaimListedAsset(ctx, sendAsset));
    if (!listed) return;
    await openClaimHold(ctx, user, siteAcc, amountEth, listed, {
      toLabel: `+${toWa}`,
      toRaw: toWa,
      toWaHint: toWa,
    });
    return;
  }

  // --- Address or trusted name, then Flizy @username / pay code ---
  const resolved = await resolveSendTarget(ctx, toRaw, isAddress, siteAcc.id);
  if (!resolved.error) {
    return handleSendResolved(ctx, user, amountEth, resolved, siteAcc, {
      skipTrusted: false,
      asset: sendAsset,
      note,
      nft: listedOverride,
    });
  }

  if (!isAddress) {
    let dest;
    try {
      dest = await resolveFlizyPayDestination(supabase, toRaw, siteAcc.id);
    } catch (err) {
      console.warn('flizy pay dest:', publicErrorMessage(err));
      dest = { found: false };
    }
    if (dest.self) {
      await reply(ctx, 'You cannot pay your own account.');
      return;
    }
    if (dest.noWallet) {
      await reply(ctx, 'That Flizy account has no wallet yet.');
      return;
    }
    if (dest.found && dest.address) {
      let firstPay = true;
      let offerSave = true;
      try {
        firstPay = !(await hasPaidMerchantBefore(supabase, siteAcc.id, dest.address));
      } catch (err) {
        console.warn('first pay check:', publicErrorMessage(err));
      }
      try {
        offerSave = !(await isSavedMerchant(supabase, siteAcc.id, dest.address));
      } catch (err) {
        console.warn('saved merchant check:', publicErrorMessage(err));
      }
      return handleSendResolved(
        ctx,
        user,
        amountEth,
        { address: dest.address, label: dest.label },
        siteAcc,
        {
          skipTrusted: true,
          asset: sendAsset,
          note,
          firstPay,
          offerSave,
          nft: listedOverride,
        }
      );
    }
  }

  await reply(ctx, resolved.error);
}

async function handleSendResolved(ctx, user, amountEth, resolved, siteAcc, opts = {}) {
  const nft = opts.nft && opts.nft.nftTokenId ? opts.nft : null;
  const sendAsset = nft ? String(nft.symbol || opts.asset || 'NFT') : normalizeSendAsset(opts.asset || 'ETH');
  const native = !nft && isNativeSendAsset(sendAsset);
  let tokenAddress = nft ? nft.tokenAddress : null;
  let tokenSymbol = nft ? nft.symbol : null;
  let tokenBalance = null;
  const nftTokenId = nft ? nft.nftTokenId : null;

  if (!native && !nft) {
    try {
      const listed = resolveListedSendAsset(sendAsset, chain.id);
      tokenAddress = listed.tokenAddress;
      tokenSymbol = listed.symbol;
    } catch (err) {
      await reply(
        ctx,
        err.message ||
          `Unknown token ${sendAsset}. Listed: ETH, FLZ.\nExample: ${cmd(ctx, 'send 10 FLZ to john')}`
      );
      return;
    }
  }

  const actor = await actorSessionFlags(ctx, user, siteAcc);
  const intent = createSendIntent({
    actor,
    amountEth,
    toAddress: resolved.address,
    toLabel: resolved.label,
    toIsAddress: true,
    chainId: String(chain.chainId),
    asset: nft ? sendAsset : native ? 'native' : sendAsset,
  });

  const policy = await evaluateSendPolicy(intent, {
    enforceTrusted: opts.skipTrusted ? false : config.enforceTrusted,
    accountRow: siteAcc,
    nativeSymbol: chain.nativeSymbol || 'ETH',
  });
  if (policy.decision === 'DENY') {
    await reply(ctx, policy.message || 'Not allowed.');
    return;
  }

  let fromAddress;
  let fromBalanceEth;
  try {
    const acc = await ensureAgentWallet(siteAcc.id);
    fromAddress = ethers.getAddress(acc.agent_wallet_address);
    fromBalanceEth = ethers.formatEther(await provider.getBalance(fromAddress));
    if (tokenAddress && !nftTokenId) {
      const erc20 = new ethers.Contract(
        tokenAddress,
        [
          'function balanceOf(address) view returns (uint256)',
          'function decimals() view returns (uint8)',
        ],
        provider
      );
      const [bal, dec] = await Promise.all([erc20.balanceOf(fromAddress), erc20.decimals()]);
      tokenBalance = ethers.formatUnits(bal, Number(dec));
    }
  } catch (err) {
    console.error('agent balance check failed:', publicErrorMessage(err));
    await reply(ctx, 'Could not check your Flizy wallet on-chain. Try again shortly.');
    return;
  }

  const plan = buildSendPlan({
    intent,
    policy,
    chain: {
      chainId: chain.chainId,
      chainName: chain.name,
      nativeSymbol: chain.nativeSymbol || 'ETH',
    },
    fromAddress,
    fromBalanceEth,
    tokenAddress,
    tokenSymbol,
    reason: opts.note || null,
    firstPay: Boolean(opts.firstPay),
    offerSave: Boolean(opts.offerSave),
    tokenBalance,
    nftTokenId,
  });
  if (opts.paymentRequestId) {
    plan.paymentRequestId = opts.paymentRequestId;
  }
  // A contribution is an ordinary send that the pot counts. The pot never
  // holds it: it lands in the organiser wallet like any other payment.
  if (opts.potId) {
    plan.potId = opts.potId;
  }

  let nftOwned;
  if (nftTokenId && tokenAddress) {
    try {
      nftOwned = await nftOwnedBy(provider, tokenAddress, nftTokenId, fromAddress);
    } catch (err) {
      console.error('nft owner check failed:', publicErrorMessage(err));
      await reply(ctx, 'Could not check that NFT. Try again shortly.');
      return;
    }
  }

  // A gator's buffer is EntryPoint's prefund, not the flat EOA figure.
  const planGasBuffer = await planGasBufferEth(provider, siteAcc.id, fromAddress);
  const funded = assertPlanFunded(plan, fromBalanceEth, planGasBuffer, {
    tokenBalance,
    nftOwned,
  });
  if (!funded.ok) {
    await reply(ctx, withFundHint(ctx, funded, funded.message));
    return;
  }

  pendingSends.set(ctx.key, {
    plan,
    createdAt: Date.now(),
    paymentRequestId: opts.paymentRequestId || null,
    payAmountEth: opts.payAmountEth || null,
  });
  await reply(ctx, formatPlanPreview(plan), { buttons: confirmButtons() });
}

async function handleConfirm(ctx, user, account) {
  pruneExpiredPending();
  const pending = pendingSends.get(ctx.key);
  if (!pending) return;

  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    pendingSends.delete(ctx.key);
    await reply(ctx, `Transfer plan expired. Start again with ${cmd(ctx, 'send ...')}`);
    return;
  }

  const plan = pending.plan;
  if (!plan) {
    pendingSends.delete(ctx.key);
    await reply(ctx, `Nothing to confirm. Start with ${cmd(ctx, 'send ...')}`);
    return;
  }

  const actorId = plan.actor?.accountId || account?.id || null;
  if (plan.actor?.accountId && account?.id && String(plan.actor.accountId) !== String(account.id)) {
    pendingSends.delete(ctx.key);
    await reply(
      ctx,
      'This chat is no longer on the account that started that send. Start again.'
    );
    return;
  }

  const lock = actorId
    ? await tryAccountTxLock(supabase, actorId, 'chat')
    : { ok: false, error: 'No account to send from.' };
  if (!lock.ok) {
    await reply(ctx, lock.error);
    return;
  }

  const paymentRequestId = pending.paymentRequestId || plan.paymentRequestId || null;
  pendingSends.delete(ctx.key);

  // Set only once an NFT has actually landed, and acted on after the tx lock is
  // released — the next round reads holdings, which has no business holding it.
  const planNftTokenId = plan.route?.nftTokenId || plan.input?.nftTokenId || null;
  let sentNftTokenId = null;

  try {
  let fresh = user;
  try {
    const res = await resolveLegacyUser(ctx, plan.actor?.accountId || account?.id || null);
    fresh = res.user;
  } catch (err) {
    console.error('confirm re-fetch user:', publicErrorMessage(err));
  }

  if (plan.intent === 'CLAIM_HOLD') {
    await reply(ctx, 'Holding funds for claim...');
    const toWaHint = plan.route.toWaHint || plan.input.toWaHint;
    const recipient = plan.route.recipient || null;
    const isPlatform = plan.input.recipientKind === 'platform';
    const isEmailClaim = plan.input.recipientKind === 'email';

    // from_wa_sender is shown to the recipient as a phone number, so it may only
    // ever hold a real one. Passing the transfer key would write "telegram:123"
    // into a phone column, and the recipient would be told the money came from
    // a number that is not the sender's.
    const senderIdentity = await resolveClaimIdentity(ctx);

    const result = await executeClaimHold({
      fromAccountId: plan.actor.accountId,
      fromWaSender: senderIdentity.waPhone || null,
      toWaHint,
      recipient,
      amountEth: plan.input.amount,
      asset: plan.input.asset || 'ETH',
      tokenAddress: plan.route.tokenAddress || null,
      nftTokenId: plan.route.nftTokenId || plan.input.nftTokenId || null,
      provider,
      chain,
      escrowWallet,
    });
    if (!result.ok) {
      await reply(ctx, withFundHint(ctx, result, result.error || 'Claim hold failed.'));
      return;
    }

    let notified = false;
    if (isPlatform && recipient?.channel && recipient?.externalId) {
      notified = await notifyClaimPlatformTarget(
        ctx,
        recipient.channel,
        recipient.externalId,
        plan.input.amount,
        plan.actor?.accountId || null,
        senderIdentity,
        plan.input.asset,
        plan.route.nftTokenId || plan.input.nftTokenId
      );
    } else if (isEmailClaim && recipient?.email) {
      notified = await notifyClaimEmailTarget(
        ctx,
        recipient.email,
        plan.input.amount,
        plan.actor?.accountId || null,
        senderIdentity,
        plan.input.asset,
        plan.route.nftTokenId || plan.input.nftTokenId
      );
    } else if (toWaHint) {
      notified = await notifyClaimTarget(
        ctx,
        toWaHint,
        plan.input.amount,
        plan.actor?.accountId || null,
        senderIdentity,
        plan.input.asset,
        plan.route.nftTokenId || plan.input.nftTokenId
      );
    }

    const howReceive = isPlatform
      ? notified
        ? 'They are on Flizy and have just been notified. They can claim in chat (flizy claim) or on the site.'
        : platformClaimLinkHowTo(recipient?.channel)
      : isEmailClaim
        ? notified
          ? 'They are on Flizy and have just been notified. They can claim in chat (flizy claim) or on the site.'
          : emailClaimLinkHowTo()
        : notified
          ? 'They are on Flizy and have just been notified. They can claim in chat (flizy claim) or on the site.'
          : 'They receive only after that number links Flizy (chat or site claim).';

    await reply(
      ctx,
      [
        'Claim held.',
        `${formatClaimAmount({
          amount_eth: plan.input.amount,
          asset: plan.input.asset,
          nft_token_id: plan.route.nftTokenId || plan.input.nftTokenId,
        })} reserved for ${plan.input.recipient}`,
        '',
        howReceive,
        `Cancel anytime: ${cmd(ctx, 'cancel claims')}`,
        '',
        'Share claim link:',
        result.claimUrl,
      ]
        .filter(Boolean)
        .join('\n')
    );
    sentNftTokenId = plan.route.nftTokenId || plan.input.nftTokenId || null;
    return;
  }

  if (plan.intent === 'NFT_MINT') {
    await reply(ctx, 'Minting...');
    let agentSigner = null;
    try {
      await ensureAgentWallet(plan.actor.accountId);
      agentSigner = getAgentSigner(plan.actor.accountId, provider);
    } catch (err) {
      console.error('nft mint signer:', publicErrorMessage(err));
    }
    const result = await executeNftMint({
      collection: plan.route.collection,
      toAddress: plan.route.toAddress,
      accountId: plan.actor.accountId,
      agentSigner,
      opsWallet,
      provider,
      chain,
      gasBufferEth: config.gasBufferEth,
    });
    if (!result.ok) {
      await reply(ctx, withFundHint(ctx, result, result.error || 'Mint failed.'));
      return;
    }
    const idLine = result.tokenId
      ? `${plan.input.ticker} #${result.tokenId}`
      : `1 ${plan.input.ticker}`;
    await reply(
      ctx,
      [
        'Minted.',
        `${idLine} is in your Flizy wallet.`,
        txUrl(result.txHash),
        '',
        `Send it: ${cmd(ctx, `nft send ${plan.input.ticker} ${result.tokenId || '1'} to @bob on telegram`)}`,
      ]
        .filter(Boolean)
        .join('\n')
    );
    return;
  }

  if (plan.intent === 'SWAP') {
    await reply(ctx, 'Submitting swap...');
    const result = await executeSwapPlan({ plan, provider, chain });
    if (!result.ok) {
      await reply(ctx, withFundHint(ctx, result, result.error || 'Swap failed.'));
      return;
    }
    await reply(ctx, 'Swap submitted. Waiting for confirmation...');
    await reply(ctx, formatSwapReceipt(result, plan));
    return;
  }

  // Take the request row before any money moves. Two channels can both hold a
  // confirmed plan for the same request; without this both would pay it and the
  // payer would be debited twice for one request.
  let heldRequest = null;
  if (paymentRequestId) {
    try {
      heldRequest = await beginRequestProcessing(paymentRequestId);
    } catch (err) {
      console.error('beginRequestProcessing:', publicErrorMessage(err));
      await reply(ctx, 'Could not check that request. Try again shortly.');
      return;
    }
    if (!heldRequest) {
      await reply(ctx, 'That request is already being paid, or is no longer open.');
      return;
    }
  }

  await reply(ctx, formatSendPending(plan));

  const result = await executeNativeSend({
    plan,
    provider,
    chain,
    user: fresh,
    supabase,
  });

  // Being paid used to be silent. The row belongs to the sender, so the only
  // way to know money arrived is to look at where it went.
  if (result.ok && plan.route?.toAddress) {
    try {
      const dest = String(plan.route.toAddress).toLowerCase();
      const { data: payee } = await supabase
        .from('accounts')
        .select('id')
        .ilike('agent_wallet_address', dest)
        .maybeSingle();
      // Paying yourself is not news, and a pot already sends its own notice.
      if (payee?.id && payee.id !== plan.actor.accountId && !plan.potId) {
        await notifyAccount(
          payee.id,
          formatReceivedNotice({
            amountEth: plan.input.amount,
            asset: plan.input.asset,
            fromLabel: await senderLabel(ctx, plan.actor.accountId, null),
            note: plan.input.reason || null,
          }),
          { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
        );
      }
    } catch (err) {
      // The money arrived; a failed notice must not read as a failed payment.
      console.warn('received notify:', publicErrorMessage(err));
    }
  }

  // A pot contribution lands in the organiser wallet like any other payment,
  // so without this they see an arrival with nothing tying it to the pot.
  if (result.ok && plan.potId) {
    try {
      const pot = await getPotById(plan.potId);
      if (pot?.owner_account_id) {
        const totals = await potTotals([pot.id]);
        await notifyAccount(
          pot.owner_account_id,
          formatPotContributionNotice({
            byLabel: await senderLabel(ctx, plan.actor.accountId, null),
            amountEth: plan.input.amount,
            potName: pot.name,
            code: pot.code,
            progress: potProgressLine(pot, totals.get(pot.id)),
          }),
          { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
        );
      }
    } catch (err) {
      // The money moved; a failed notice must not read as a failed payment.
      console.warn('pot contribution notify:', publicErrorMessage(err));
    }
  }

  if (paymentRequestId) {
    try {
      if (result.ok) {
        // The amount settles the row; the status follows it, so a part payment
        // leaves the request open for the rest.
        const settledRow = await markRequestPaid(
          paymentRequestId,
          plan.actor.accountId,
          result.txHash || null,
          pending?.payAmountEth || null
        );
        // Requester hears on every linked channel (WA + TG). Payer already has
        // the receipt in this chat; skip that identity so we do not double-ping them.
        const requesterId = heldRequest?.requester_account_id;
        if (requesterId) {
          try {
            const fromLabel = await senderLabel(ctx, plan.actor.accountId, null);
            await notifyAccount(
              requesterId,
              formatRequestPaidNotice({
                // What actually landed, not what was asked. On a part payment
                // the old line told the requester the whole ask had been paid.
                amountEth: pending?.payAmountEth || heldRequest.amount_eth || plan.input.amount,
                fromLabel,
                remainingEth: settledRow ? requestRemainingEth(settledRow) : null,
                explorerUrl: result.explorerUrl || null,
              }),
              { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
            );
          } catch (err) {
            console.warn('request paid notify:', publicErrorMessage(err));
          }
        }
      } else if (!result.submitted) {
        // Nothing reached the chain, so the request is open again. Only safe
        // because executeNativeSend tells us it never submitted.
        await releaseRequestProcessing(paymentRequestId);
      } else {
        console.error(
          `[request] ${paymentRequestId} left in processing after a submitted transfer. Check the chain before reopening it.`
        );
      }
    } catch (err) {
      console.warn('payment request settle:', publicErrorMessage(err));
    }
  }

  await reply(ctx, withFundHint(ctx, result, formatSendReceipt(result, plan)));
  if (result.ok) {
    sentNftTokenId = plan.route?.nftTokenId || plan.input?.nftTokenId || null;
  }
  if (result.ok && plan.input?.offerSave && plan.route?.toAddress) {
    const label = String(plan.input.recipientLabel || '').replace(/^@/, '') || 'merchant';
    pendingMerchantSaves.set(ctx.key, {
      address: plan.route.toAddress,
      label,
      createdAt: Date.now(),
    });
    await reply(
      ctx,
      [
        `Paid. Save ${plan.input.recipientLabel || 'them'} as a trusted contact?`,
        'Next send can use their name instead of looking them up again.',
        `Reply ${cmd(ctx, 'save')} to add them, or ${cmd(ctx, 'skip')}.`,
      ].join('\n')
    );
  }
  } finally {
    if (actorId) await releaseAccountTxLock(supabase, actorId);
    if (planNftTokenId) {
      // Never let the batch step throw away a send that already succeeded: the
      // money moved, and the receipt above is the part that must stand.
      try {
        if (sentNftTokenId) {
          await advanceMultiNftSend(ctx, user, account, sentNftTokenId);
        } else {
          // This one did not land. Close the batch rather than leave it open:
          // a stale batch would otherwise wake up on the next NFT send and ask
          // about NFTs nobody is sending any more.
          await abortMultiNftSend(ctx);
        }
      } catch (err) {
        console.error('multi nft advance:', publicErrorMessage(err));
        pendingMultiNftSends.delete(ctx.key);
      }
    }
  }
}

async function handleCancel(ctx) {
  if (pendingClaimMenus.has(ctx.key)) {
    pendingClaimMenus.delete(ctx.key);
    await reply(ctx, 'Menu closed.');
    return true;
  }
  if (pendingSends.has(ctx.key)) {
    pendingSends.delete(ctx.key);
    await reply(ctx, 'Plan cancelled. Nothing was executed.');
    return true;
  }
  if (pendingPayAsks.has(ctx.key)) {
    pendingPayAsks.delete(ctx.key);
    await reply(ctx, 'Pay cancelled.');
    return true;
  }
  if (pendingMerchantSaves.has(ctx.key)) {
    pendingMerchantSaves.delete(ctx.key);
    await reply(ctx, 'Not saved.');
    return true;
  }
  if (pendingPayCodes.has(ctx.key)) {
    pendingPayCodes.delete(ctx.key);
    await reply(ctx, 'Cancelled. Nothing was sent.');
    return true;
  }
  if (pendingTokenBuys.has(ctx.key)) {
    pendingTokenBuys.delete(ctx.key);
    await reply(ctx, 'Cancelled. Nothing was bought.');
    return true;
  }
  return false;
}

async function handleSwapCommand(ctx, user, account, parsed) {
  if (parsed.kind === 'price') {
    try {
      const sym = String(parsed.symbol || 'FLZ').toUpperCase();
      if (sym !== 'FLZ' && sym !== 'FLIZY') {
        await reply(ctx, `Price supported for FLZ.\nExample: ${cmd(ctx, 'price FLZ')}`);
        return;
      }
      const px = await getFlzPrice(provider, chain.id);
      await reply(
        ctx,
        [
          'FLZ price',
          `1 ETH ≈ ${formatEth(px.flzPerEth)} FLZ`,
          `1 FLZ ≈ ${formatEth(px.ethPerFlz)} ETH`,
        ].join('\n')
      );
    } catch (err) {
      console.error('price:', publicErrorMessage(err));
      await reply(ctx, 'Could not read price. Try again shortly.');
    }
    return;
  }

  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  const dex = getDexConfig(chain.id);
  if (!dex.feeRouter || !dex.flz) {
    await reply(ctx, 'Swap not configured on this chain yet.');
    return;
  }

  if (parsed.kind === 'trade_ambiguous') {
    await askTradeDirection(ctx, parsed.amount, parsed.symbol);
    return;
  }

  let tokenInLabel;
  let tokenOutLabel;
  let tokenIn;
  let tokenOut;
  const amountStr = parsed.amount;

  try {
    if (parsed.kind === 'buy') {
      // "buy 100 flz" pays with ETH; "buy 0.1 eth of flz" names the payer side.
      const inRaw = String(parsed.tokenIn || 'ETH').toUpperCase();
      tokenInLabel = tokenLabel(parsed.tokenIn || 'ETH', chain.id);
      tokenOutLabel = tokenLabel(parsed.tokenOut, chain.id);
      tokenIn =
        inRaw === 'ETH' || inRaw === 'NATIVE' ? null : resolveToken(parsed.tokenIn, chain.id);
      tokenOut = resolveToken(parsed.tokenOut, chain.id);
      if (tokenOut === null) {
        await reply(ctx, 'Buy target must be a token (e.g. FLZ), not ETH.');
        return;
      }
    } else if (parsed.kind === 'sell') {
      tokenInLabel = tokenLabel(parsed.tokenIn, chain.id);
      tokenOutLabel = 'ETH';
      tokenIn = resolveToken(parsed.tokenIn, chain.id);
      tokenOut = null;
      if (tokenIn === null) {
        await reply(ctx, 'Sell input must be a token (e.g. FLZ), not ETH.');
        return;
      }
    } else {
      tokenInLabel = tokenLabel(parsed.tokenIn, chain.id);
      tokenOutLabel = tokenLabel(parsed.tokenOut, chain.id);
      const rawIn = String(parsed.tokenIn || '').toUpperCase();
      const rawOut = String(parsed.tokenOut || '').toUpperCase();
      tokenIn = rawIn === 'ETH' || rawIn === 'NATIVE' ? null : resolveToken(parsed.tokenIn, chain.id);
      tokenOut =
        rawOut === 'ETH' || rawOut === 'NATIVE' ? null : resolveToken(parsed.tokenOut, chain.id);
    }
  } catch (err) {
    await reply(ctx, err.message || 'Unknown token.');
    return;
  }

  // 'out' means the user named what they want to RECEIVE ("buy 100 FLZ"), so
  // the input is solved for here. Execution below is unchanged either way: the
  // router only has exact-in entrypoints, and this stays a quoting step.
  const wantsExactOut = parsed.amountMode === 'out';
  let amountInWei;
  let targetOutWei = null;
  try {
    const typed = ethers.parseEther(String(amountStr));
    if (typed <= 0n) throw new Error('bad');
    if (wantsExactOut) targetOutWei = typed;
    else amountInWei = typed;
  } catch {
    await reply(ctx, `Invalid amount.\nExample: ${cmd(ctx, 'buy 100 FLZ')}`);
    return;
  }

  if (wantsExactOut) {
    try {
      const exact = await quoteExactOut({
        provider,
        amountOut: targetOutWei,
        tokenIn,
        tokenOut,
        chainKey: chain.id,
      });
      amountInWei = exact.amountIn;
    } catch (err) {
      console.error('quoteExactOut:', publicErrorMessage(err));
      await reply(
        ctx,
        [
          `Could not price ${amountStr} ${tokenOutLabel}.`,
          'The pool may not hold that much. Try a smaller amount,',
          `or name your spend: ${cmd(ctx, `buy 0.01 ${tokenInLabel} of ${tokenOutLabel}`)}`,
        ].join('\n')
      );
      return;
    }
  }

  const actor = await actorSessionFlags(ctx, user, siteAcc);
  const intent = createSwapIntent({
    actor,
    side: parsed.kind,
    // Always the resolved input. On an exact-out buy this is the solved ETH
    // spend, not the FLZ the user typed, so policy sees what actually leaves.
    amountIn: ethers.formatEther(amountInWei),
    tokenInLabel,
    tokenOutLabel,
    tokenIn,
    tokenOut,
    routerAddress: dex.feeRouter,
    chainId: chain.id,
    slippageBps: config.swapSlippageBps,
  });

  const policy = await evaluateSwapPolicy(intent);
  if (policy.decision === 'DENY') {
    await reply(ctx, policy.message || 'Swap not allowed.');
    return;
  }

  let quote;
  try {
    quote = await quoteSwap({
      provider,
      amountIn: amountInWei,
      tokenIn,
      tokenOut,
      chainKey: chain.id,
      slippageBps: config.swapSlippageBps,
    });
  } catch (err) {
    console.error('quoteSwap:', publicErrorMessage(err));
    await reply(
      ctx,
      `Could not quote swap (pool or amount issue). Try a smaller amount or ${cmd(ctx, 'price FLZ')}.`
    );
    return;
  }

  const feePct = `${(quote.feeBps / 100).toFixed(2)}%`;
  const slipPct = `${(quote.slippageBps / 100).toFixed(2)}%`;
  const plan = buildSwapPlan({
    intent,
    policy,
    chain: { chainId: chain.chainId, chainName: chain.name, nativeSymbol: chain.nativeSymbol },
    fromAddress: siteAcc.agent_wallet_address,
    amountInDisplay: formatEth(ethers.formatEther(amountInWei)),
    amountOutDisplay: formatEth(ethers.formatEther(quote.amountOut)),
    feeDisplay: formatEth(ethers.formatEther(quote.feeAmount)),
    feePctDisplay: feePct,
    slippagePctDisplay: slipPct,
    tokenInLabel,
    tokenOutLabel,
    routerAddress: dex.feeRouter,
    amountInWei: amountInWei.toString(),
    amountOutMinWei: quote.amountOutMin.toString(),
    inIsNative: quote.inIsNative,
    outIsNative: quote.outIsNative,
    tokenIn,
    tokenOut,
    targetOutDisplay: wantsExactOut ? formatEth(ethers.formatEther(targetOutWei)) : null,
  });

  pendingSends.set(ctx.key, { plan, createdAt: Date.now() });
  await reply(ctx, formatSwapPlanPreview(plan), { buttons: confirmButtons() });
}

/**
 * "trade 100 flz" names one side and no direction. Ask which way.
 *
 * Numbered text, no inline buttons. Telegram's callback handler only accepts
 * confirm and cancel (lib/telegram/bot.js), which keeps a stale button from an
 * old message from firing a command later. Widening that allowlist to carry a
 * menu pick is not worth it for a shortcut, so the numbered list is the whole
 * interface and it reads the same on both channels. Each answer is a complete
 * command, so answering is the same as having typed it.
 */
async function askTradeDirection(ctx, amount, symbol) {
  const label = tokenLabel(symbol, chain.id);
  const native = chain.nativeSymbol;

  if (label === native || label === 'ETH') {
    // Only one direction reads sensibly for the native coin: spend it.
    await reply(
      ctx,
      [
        `Say what you want for your ${amount} ${label}.`,
        `Example: ${cmd(ctx, `swap ${amount} ${label} for FLZ`)}`,
      ].join('\n')
    );
    return;
  }

  const options = [
    {
      keyword: 'sell',
      label: `Sell ${amount} ${label} for ${native}`,
      command: `sell ${amount} ${label}`,
    },
    {
      keyword: 'buy',
      label: `Buy ${amount} ${label} with ${native}`,
      command: `buy ${amount} ${label}`,
    },
  ];

  pendingChoices.set(ctx.key, { options, createdAt: Date.now() });

  await reply(
    ctx,
    [
      `Trade ${amount} ${label} — which way?`,
      ...options.map((o, i) => `  ${i + 1}. ${o.label}`),
      '',
      'Reply 1 or 2, or: cancel',
    ].join('\n')
  );
}

/**
 * Answer to a numbered question the bot asked.
 *
 * @returns {Promise<boolean>} true when the message was consumed as an answer
 */
async function handleChoiceReply(ctx, user, account, text) {
  const choice = pendingChoices.get(ctx.key);
  if (!choice) return false;

  const t = String(text || '').trim().toLowerCase();
  if (isCancelCommand(t)) {
    pendingChoices.delete(ctx.key);
    await reply(ctx, 'Cancelled.');
    return true;
  }

  let picked = null;
  if (/^\d+$/.test(t)) {
    const idx = Number(t) - 1;
    picked = idx >= 0 && idx < choice.options.length ? choice.options[idx] : null;
    // The list numbers the ids, so digits are read as a position first. Typing
    // the id itself is the other natural answer; it is only taken when it is
    // not a position, so one reply can never mean two different NFTs.
    if (!picked) {
      picked = choice.options.find((o) => o.tokenId && String(o.tokenId) === t) || null;
    }
    if (!picked) {
      await reply(ctx, `Pick 1–${choice.options.length}, or: cancel`);
      return true;
    }
  } else {
    picked =
      choice.options.find(
        (o) =>
          o.keyword === t ||
          (o.command && String(o.command).toLowerCase() === t) ||
          (o.tokenId && String(o.tokenId) === t)
      ) || null;
  }

  // Not an answer: leave the question open and let the router read it as a new
  // command, the way the claim menu does.
  if (!picked) return false;

  pendingChoices.delete(ctx.key);

  if (choice.kind === 'sendNft' && picked.tokenId) {
    await dispatchNamedNftSend(ctx, user, account, choice.dest, choice.ticker, picked.tokenId);
    return true;
  }
  if (choice.kind === 'sendKind') {
    if (picked.keyword === 'nft') {
      if (choice.count != null || (choice.ids && choice.ids.length)) {
        await startMultiNftSend(
          ctx,
          user,
          account,
          choice.dest,
          choice.ticker,
          choice.nft,
          choice.count,
          choice.ids
        );
        return true;
      }
      await continueNamedNftSend(ctx, user, account, choice.dest, choice.ticker, choice.nft);
      return true;
    }
    if (picked.keyword === 'token') {
      // They already said how many; asking again would be asking twice.
      if (choice.count != null && !(choice.ids && choice.ids.length)) {
        await handleSend(
          ctx,
          user,
          account,
          String(choice.count),
          choice.dest.toRaw,
          Boolean(choice.dest.isAddress),
          Boolean(choice.dest.isPhone),
          String(choice.ticker).toUpperCase(),
          choice.dest.platform || null,
          Boolean(choice.dest.isEmail)
        );
        return true;
      }
      await askNamedTokenAmount(ctx, choice.dest, choice.ticker, choice.token);
      return true;
    }
    return true;
  }

  const parsed = parseSwapCommand(picked.command);
  if (!parsed) return true;
  await handleSwapCommand(ctx, user, account, parsed);
  return true;
}

async function dispatchNamedNftSend(ctx, user, account, dest, ticker, tokenId) {
  await handleSend(
    ctx,
    user,
    account,
    '1',
    dest.toRaw,
    Boolean(dest.isAddress),
    Boolean(dest.isPhone),
    String(ticker || 'NFT').toUpperCase(),
    dest.platform || null,
    Boolean(dest.isEmail),
    null,
    { ticker, tokenId: String(tokenId) }
  );
}

async function continueNamedNftSend(ctx, user, account, dest, ticker, nft, progress) {
  const ids = (nft && Array.isArray(nft.ids) ? nft.ids : []).filter(Boolean);
  if (ids.length === 1) {
    await dispatchNamedNftSend(ctx, user, account, dest, ticker, ids[0]);
    return;
  }
  if (!ids.length) {
    await reply(
      ctx,
      [
        `You hold ${nft && nft.balance ? nft.balance : 'some'} ${ticker}, but I could not list token ids.`,
        `Send with an id: ${cmd(ctx, `nft send ${ticker} 21 to ${dest.toRaw}`)}`,
      ].join('\n')
    );
    return;
  }
  const options = ids.slice(0, MAX_NFT_PICKS).map((id) => ({
    keyword: String(id),
    label: `${ticker} ${id}`,
    tokenId: String(id),
  }));
  pendingChoices.set(ctx.key, {
    kind: 'sendNft',
    options,
    dest,
    ticker,
    createdAt: Date.now(),
  });
  const extra =
    ids.length > MAX_NFT_PICKS
      ? `\nShowing ${MAX_NFT_PICKS} of ${ids.length}.` +
        `\nAny other id: ${cmd(ctx, `nft send ${ticker} <id> to ${dest.toRaw}`)}`
      : '';
  // Mid-batch the question is "which one next", and the counter is the only
  // thing telling them how many confirms are still coming.
  const header = progress
    ? `Which ${ticker} next? (${progress.done + 1} of ${progress.total})`
    : `Which ${ticker} do you want to send?`;
  await reply(
    ctx,
    [
      header,
      ...options.map((o, i) => `${i + 1}. ${o.label}`),
      extra,
      '',
      `Reply ${options.length === 1 ? '1' : `1–${options.length}`}, or: cancel`,
    ]
      .filter((line) => line !== '')
      .join('\n'),
    { buttons: numberButtons(options.length) }
  );
}

/** "1123", "1123 and 1128", "1123, 1128 and 1131" */
function joinIds(ids) {
  const list = (ids || []).map(String);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * Open a counted NFT send: `send 2 giwaforge to bob`.
 *
 * ERC-721 moves one id per call, so two NFTs is two transactions and two
 * confirms. This validates the ask against what is actually held, then runs the
 * first round. Nothing sends more than one NFT on a single approval.
 *
 * @param {string[]|null} ids explicit ids the sender named, else null
 */
async function startMultiNftSend(ctx, user, account, dest, ticker, nft, count, ids) {
  const available = (nft && Array.isArray(nft.ids) ? nft.ids : []).filter(Boolean).map(String);
  const balance = Number(nft && nft.balance != null ? nft.balance : available.length) || 0;

  if (ids && ids.length) {
    const dupe = firstDuplicateId(ids);
    if (dupe) {
      await reply(ctx, `You named ${ticker} ${dupe} twice. Each NFT can only be sent once.`);
      return;
    }
    if (count != null && count !== ids.length) {
      await reply(
        ctx,
        [
          `You asked for ${count} ${ticker} but named ${ids.length} id${ids.length === 1 ? '' : 's'}.`,
          `To send those: ${cmd(ctx, `send ${ids.length} ${ticker} ${ids.join(' ')} to ${dest.toRaw}`)}`,
        ].join('\n')
      );
      return;
    }
    // An id scan that came back empty is a failed read, not proof of an empty
    // wallet, so only contradict the sender when the list is actually known.
    if (available.length) {
      const missing = ids.filter((id) => !available.includes(String(id)));
      if (missing.length) {
        await reply(
          ctx,
          [
            `You do not hold ${ticker} ${joinIds(missing)}.`,
            `You hold: ${joinIds(available)}.`,
          ].join('\n')
        );
        return;
      }
    }
    pendingMultiNftSends.set(ctx.key, {
      dest,
      ticker,
      remaining: ids.length,
      total: ids.length,
      ids: ids.map(String),
      sentIds: [],
      createdAt: Date.now(),
    });
    await runMultiNftRound(ctx, user, account);
    return;
  }

  if (count != null && count < 1) {
    await reply(
      ctx,
      [
        `Send at least one ${ticker}.`,
        `Example: ${cmd(ctx, `send 1 ${ticker} to ${dest.toRaw}`)}`,
      ].join('\n')
    );
    return;
  }

  // Fewer held than asked for: refuse the whole batch rather than quietly
  // sending what happens to be there. A half-filled send is not what they typed.
  if (count != null && count > balance) {
    await reply(
      ctx,
      [
        `You only have ${balance} ${ticker}${available.length ? `: ${joinIds(available)}` : ''}.`,
        balance > 0
          ? `Send ${balance === 1 ? 'it' : 'them'}: ${cmd(ctx, `send ${balance} ${ticker} to ${dest.toRaw}`)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
    return;
  }

  pendingMultiNftSends.set(ctx.key, {
    dest,
    ticker,
    remaining: count,
    total: count,
    ids: null,
    sentIds: [],
    createdAt: Date.now(),
  });
  await runMultiNftRound(ctx, user, account, nft);
}

/**
 * One round of a counted send: work out which id goes next, then open its
 * confirm. Called once to start the batch and again after every success.
 *
 * @param {object} [knownNft] holdings already read this tick, to save an RPC hop
 */
async function runMultiNftRound(ctx, user, account, knownNft) {
  const state = pendingMultiNftSends.get(ctx.key);
  if (!state) return;
  const first = state.sentIds.length === 0;

  // An explicit list goes in the order the sender wrote it.
  if (state.ids) {
    const next = state.ids[state.sentIds.length];
    if (!next) {
      await finishMultiNftSend(ctx);
      return;
    }
    if (first && state.total > 1) {
      await reply(ctx, `Sending ${state.total} ${state.ticker}: ${joinIds(state.ids)}.`);
    }
    await announceMultiNftRound(ctx, state, next);
    await dispatchNamedNftSend(ctx, user, account, state.dest, state.ticker, next);
    return;
  }

  let nft = knownNft;
  if (!nft) {
    const siteAcc = await requireLinkedSite(ctx, account);
    if (!siteAcc || !siteAcc.agent_wallet_address) {
      pendingMultiNftSends.delete(ctx.key);
      return;
    }
    try {
      // Re-read rather than cache: the one just sent has left the wallet, and a
      // fresh read is what drops it from the next list.
      const found = await lookupNamedAssetHoldings(
        siteAcc.agent_wallet_address,
        state.ticker,
        chain
      );
      nft = found.nft;
    } catch (err) {
      console.error('multi nft round lookup:', publicErrorMessage(err));
      await reply(ctx, 'Could not read that holding. Try again shortly.');
      return;
    }
  }

  const available = (nft && Array.isArray(nft.ids) ? nft.ids : []).filter(Boolean).map(String);
  if (!available.length) {
    pendingMultiNftSends.delete(ctx.key);
    await reply(
      ctx,
      [
        `No ${state.ticker} left to send.`,
        state.sentIds.length ? `Sent: ${joinIds(state.sentIds)}.` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
    return;
  }

  // Nothing to choose between: the wallet holds exactly what is still owed.
  if (available.length <= state.remaining) {
    if (first) {
      await reply(ctx, `You have ${available.length} ${state.ticker}: ${joinIds(available)}.`);
    }
    await announceMultiNftRound(ctx, state, available[0]);
    await dispatchNamedNftSend(ctx, user, account, state.dest, state.ticker, available[0]);
    return;
  }

  // More held than owed, so which one goes is the sender's call.
  await continueNamedNftSend(
    ctx,
    user,
    account,
    state.dest,
    state.ticker,
    { ...nft, ids: available },
    { done: state.sentIds.length, total: state.total }
  );
}

async function announceMultiNftRound(ctx, state, tokenId) {
  if (state.total <= 1) return;
  const done = state.sentIds.length;
  await reply(
    ctx,
    done === 0
      ? `Sending 1 of ${state.total}: ${state.ticker} ${tokenId}`
      : `${state.remaining} left: ${state.ticker} ${tokenId}`
  );
}

async function finishMultiNftSend(ctx) {
  const state = pendingMultiNftSends.get(ctx.key);
  pendingMultiNftSends.delete(ctx.key);
  if (!state || state.total <= 1) return;
  await reply(
    ctx,
    [
      state.total === 2 ? 'Both sent.' : `All ${state.total} sent.`,
      `${state.ticker}: ${joinIds(state.sentIds)}`,
    ].join('\n')
  );
}

/**
 * A round did not land, so the batch stops here.
 *
 * Says what did go and hands back the command for the rest. Re-offering the
 * same confirm instead would just walk a persistent failure round and round.
 */
async function abortMultiNftSend(ctx) {
  const state = pendingMultiNftSends.get(ctx.key);
  pendingMultiNftSends.delete(ctx.key);
  if (!state || state.total <= 1) return;
  const left = state.remaining;
  await reply(
    ctx,
    [
      state.sentIds.length
        ? `Stopped after ${state.sentIds.length} of ${state.total}. Sent: ${joinIds(state.sentIds)}.`
        : `Nothing sent.`,
      `To try the remaining ${left}: ${cmd(ctx, `send ${left} ${state.ticker} to ${state.dest.toRaw}`)}`,
    ].join('\n')
  );
}

/**
 * One NFT of a batch just landed. Move to the next, or close the batch out.
 *
 * A no-op when no batch is open, which is every ordinary single NFT send.
 */
async function advanceMultiNftSend(ctx, user, account, tokenId) {
  const state = pendingMultiNftSends.get(ctx.key);
  if (!state) return;
  if (tokenId != null) state.sentIds.push(String(tokenId));
  state.remaining = Math.max(0, state.remaining - 1);
  // Each confirm restarts the clock, so a batch cannot expire mid-way through
  // just because the sender took their time over the first one.
  state.createdAt = Date.now();
  if (state.remaining <= 0) {
    await finishMultiNftSend(ctx);
    return;
  }
  await runMultiNftRound(ctx, user, account);
}

async function askNamedTokenAmount(ctx, dest, ticker, token) {
  pendingNamedSends.set(ctx.key, {
    dest,
    ticker,
    createdAt: Date.now(),
  });
  const have = token && token.balance != null ? ` You have ${token.balance}.` : '';
  await reply(ctx, `How much ${ticker}?${have}\nReply with an amount, or: cancel`);
}

async function handleNamedAssetSend(ctx, user, account, named) {
  // A freshly typed send starts over, so an abandoned batch cannot latch onto
  // it. The rounds themselves go through dispatchNamedNftSend, not here.
  pendingMultiNftSends.delete(ctx.key);

  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  const wallet = siteAcc.agent_wallet_address;
  if (!wallet) {
    await reply(ctx, 'No Flizy wallet on this account yet. Open the dashboard, then try again.');
    return;
  }

  const dest = {
    toRaw: named.toRaw,
    isAddress: named.isAddress,
    isPhone: named.isPhone,
    isEmail: named.isEmail,
    platform: named.platform,
  };

  let found;
  try {
    // Same chain the send will execute on, not the process default.
    found = await lookupNamedAssetHoldings(wallet, named.ticker, chain);
  } catch (err) {
    console.error('named asset lookup:', publicErrorMessage(err));
    await reply(ctx, 'Could not read that holding. Try again shortly.');
    return;
  }

  const token = named.nftOnly ? null : found.token;
  const nft = found.nft;
  if (!token && !nft) {
    // Saying "you do not hold giwaforge" to someone who holds the token and
    // asked for the NFT is wrong twice over: it denies a balance they can see
    // in `balance`, and it hides the one word standing between them and the
    // send they wanted.
    const heldAsToken = named.nftOnly && found.token;
    await reply(
      ctx,
      heldAsToken
        ? [
            `You do not hold any ${named.ticker} NFTs in this wallet.`,
            `You do hold ${found.token.balance} ${named.ticker} as a token.`,
            `To send that: ${cmd(ctx, `send ${named.ticker} to ${named.toRaw}`)}`,
          ].join('\n')
        : [
            `You do not hold ${named.ticker} in this wallet.`,
            `Check with ${cmd(ctx, 'balance')}.`,
          ].join('\n')
    );
    return;
  }

  if (token && nft) {
    const options = [
      {
        keyword: 'token',
        label: `${named.ticker} token (${token.balance})`,
      },
      {
        keyword: 'nft',
        label: `${named.ticker} NFT (${nft.balance})`,
      },
    ];
    pendingChoices.set(ctx.key, {
      kind: 'sendKind',
      options,
      dest,
      ticker: named.ticker,
      token,
      nft,
      // A count survives the token-or-NFT question: answering "NFT" to
      // `send 2 giwaforge to bob` still means two.
      count: named.count,
      ids: named.ids,
      createdAt: Date.now(),
    });
    await reply(
      ctx,
      [
        `You hold ${named.ticker} as a token and as NFTs. Which do you send?`,
        '1. ' + options[0].label,
        '2. ' + options[1].label,
        '',
        'Reply 1 or 2, or: cancel',
      ].join('\n'),
      { buttons: numberButtons(2) }
    );
    return;
  }

  if (nft) {
    if (named.count != null || (named.ids && named.ids.length)) {
      await startMultiNftSend(
        ctx,
        user,
        account,
        dest,
        named.ticker,
        nft,
        named.count,
        named.ids
      );
      return;
    }
    await continueNamedNftSend(ctx, user, account, dest, named.ticker, nft);
    return;
  }

  // A count in front of something held only as a token is an ordinary amount.
  // Hand it back to the plain send path so it behaves exactly as it always has.
  if (named.count != null && !named.ids) {
    await handleSend(
      ctx,
      user,
      account,
      String(named.count),
      dest.toRaw,
      Boolean(dest.isAddress),
      Boolean(dest.isPhone),
      named.ticker.toUpperCase(),
      dest.platform || null,
      Boolean(dest.isEmail)
    );
    return;
  }

  await askNamedTokenAmount(ctx, dest, named.ticker, token);
}

// ---------------------------------------------------------------------------
// Numbered menus for claims and payment requests. Shared because both use
// pendingClaimMenus; claim modes call into handlers/claims, request modes
// stay in this file.
// ---------------------------------------------------------------------------

/**
 * Menu reply: 1 | 2 | All | confirm (for single item menus)
 * modes: cancel | claim | pay_request | cancel_request
 */
async function handleClaimMenuReply(ctx, user, account, text) {
  const menu = pendingClaimMenus.get(ctx.key);
  if (!menu) return false;

  const t = String(text || '').trim().toLowerCase();
  if (isCancelCommand(t)) {
    pendingClaimMenus.delete(ctx.key);
    await reply(ctx, 'Menu closed.');
    return true;
  }

  const list = menu.requests || menu.claims || [];

  // "decline" answers the same open question "confirm" does, so it is read in
  // the same place rather than as a command of its own.
  if (menu.awaitConfirmId && isDeclineCommand(t)) {
    pendingClaimMenus.delete(ctx.key);
    if (menu.mode === 'pay_request') {
      await runDeclineOneRequest(ctx, user, account, menu.awaitConfirmId);
    } else {
      await reply(ctx, 'Nothing here to decline. Reply: confirm, or cancel.');
    }
    return true;
  }

  // "decline 2" picks a row out of a numbered incoming menu.
  const declinePick = parseDeclineCommand(t);
  if (declinePick && menu.mode === 'pay_request') {
    const idx = declinePick.index - 1;
    if (idx < 0 || idx >= list.length) {
      await reply(ctx, `Pick 1-${list.length} to decline.`);
      return true;
    }
    pendingClaimMenus.delete(ctx.key);
    await runDeclineOneRequest(ctx, user, account, list[idx].id);
    return true;
  }

  // A bare amount against an open request pays that much of it. "confirm"
  // still means all of it, so the common case is unchanged.
  if (menu.awaitConfirmId && menu.mode === 'pay_request') {
    const part = parseBareAmount(t);
    if (part) {
      pendingClaimMenus.delete(ctx.key);
      await startPayRequest(ctx, user, account, menu.awaitConfirmId, part);
      return true;
    }
  }

  if (menu.awaitConfirmId && isConfirmCommand(t)) {
    pendingClaimMenus.delete(ctx.key);
    if (menu.mode === 'cancel') {
      await runCancelOneClaim(ctx, account, menu.awaitConfirmId);
    } else if (menu.mode === 'claim') {
      await runPayoutOneClaim(ctx, user, account, menu.awaitConfirmId);
    } else if (menu.mode === 'pay_request') {
      await startPayRequest(ctx, user, account, menu.awaitConfirmId);
    } else if (menu.mode === 'cancel_request') {
      await runCancelOneRequest(ctx, account, menu.awaitConfirmId);
    }
    return true;
  }

  let selected = [];
  if (t === 'all') {
    selected = list.slice();
  } else if (/^\d+$/.test(t)) {
    const idx = Number(t) - 1;
    if (idx < 0 || idx >= list.length) {
      await reply(ctx, `Pick 1–${list.length}, All, or cancel.`);
      return true;
    }
    selected = [list[idx]];
  } else {
    return false;
  }

  pendingClaimMenus.delete(ctx.key);

  if (menu.mode === 'cancel') {
    for (const c of selected) await runCancelOneClaim(ctx, account, c.id);
  } else if (menu.mode === 'claim') {
    for (const c of selected) await runPayoutOneClaim(ctx, user, account, c.id);
  } else if (menu.mode === 'pay_request') {
    if (selected.length > 1) {
      await reply(
        ctx,
        'Pay one request at a time. Reply with a single number, then confirm the plan.'
      );
      pendingClaimMenus.set(ctx.key, { ...menu, createdAt: Date.now() });
      return true;
    }
    await startPayRequest(ctx, user, account, selected[0].id);
  } else if (menu.mode === 'cancel_request') {
    for (const r of selected) await runCancelOneRequest(ctx, account, r.id);
  }
  return true;
}

/**
 * Who a typed name means, for anything that asks a person for money.
 *
 * Shared by `request` and `split` so the two cannot disagree about what
 * `@ada` resolves to. Throws with a message meant for the user; the caller
 * decides how to say it, because a split failing on person three reads
 * differently from a single request failing.
 *
 * @returns {Promise<{ recipient: object, label: string }>}
 */
async function resolveRequestTarget({ raw, kind, platform, mine, siteAcc }) {
  if (kind === 'address') {
    throw new Error('A request has to reach a person, and an address cannot be told about one.');
  }

  if (kind === 'phone') {
    const phone = normalizeWaHint(raw);
    if (!isPlausiblePhone(phone)) {
      throw new Error('Invalid phone. Use country code digits.');
    }
    const mineNumbers = [mine.waPhone, mine.waSenderId]
      .filter(Boolean)
      .map((n) => normalizeWaHint(n));
    if (mineNumbers.includes(phone)) {
      throw new Error('You cannot request money from your own number.');
    }
    return { recipient: phoneRecipient(phone), label: `+${phone}` };
  }

  if (kind === 'email') {
    const recipient = emailRecipient(raw);
    return { recipient, label: recipient.email };
  }

  if (kind === 'platform') {
    // Resolving a handle to its immutable id lives inline in
    // handleSendPlatformClaim (lib/handlers/claims.js); copying it here is
    // how the two would drift.
    throw new Error(`Requests cannot reach a ${platform} handle yet.`);
  }

  const ref = await resolvePayRef(supabase, raw);
  if (!ref?.accountId) {
    throw new Error(`No Flizy account called ${displaySafeLabel(raw)}.`);
  }
  if (ref.accountId === siteAcc.id) {
    throw new Error('You cannot request money from yourself.');
  }
  return {
    recipient: accountRecipient(ref.accountId, ref.username || raw),
    label: ref.username ? `@${ref.username}` : raw,
  };
}

/** One body, sent to whichever channel the payer reads it on. */
async function notifyRequestTarget(ctx, recipient, body) {
  const skip = { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] };
  if (recipient.kind === 'account') return notifyAccount(recipient.accountId, body, skip);
  if (recipient.kind === 'phone') return notifyPhone(recipient.phone, body, skip);
  // Platform and email requests reach the payer when they next ask, the same
  // way a claim addressed to an unlinked identity does. Nothing to push to.
  return null;
}

/**
 * request <amount> from <person>
 *
 * The person can be anything a send can reach except a raw address. Which
 * shape it was is decided by the parser; this resolves it to a recipient the
 * database can store exactly one way.
 */
async function handleRequestMoney(ctx, user, account, parsed) {
  const { amountEth, fromRaw, platform } = parsed;
  const kind = parsed.kind || (parsed.isPhone ? 'phone' : 'alias');
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  let amountNum;
  try {
    amountNum = Number(amountEth);
    ethers.parseEther(String(amountEth));
    if (!(amountNum > 0)) throw new Error('bad');
  } catch {
    await reply(
      ctx,
      `Invalid amount.\nExample: ${cmd(ctx, 'request 0.001 from 2348012345678')}`
    );
    return;
  }
  if (amountNum > config.maxSendEth) {
    await reply(ctx, `Max per request is ${config.maxSendEth} ETH.`);
    return;
  }

  // A send may move money to a raw address. A request may not: it has to reach
  // someone who can be told about it, and an address is nobody.
  if (kind === 'address') {
    await reply(
      ctx,
      [
        'A request has to reach a person, and an address cannot be told about one.',
        'Ask by name, phone, platform or email:',
        `  ${cmd(ctx, `request ${amountEth} from @name`)}`,
        `  ${cmd(ctx, `request ${amountEth} from 234…`)}`,
      ].join('\n')
    );
    return;
  }

  const mine = await resolveClaimIdentity(ctx);

  let recipient;
  let fromLabel;
  try {
    ({ recipient, label: fromLabel } = await resolveRequestTarget({
      raw: fromRaw,
      kind,
      platform,
      mine,
      siteAcc,
    }));
  } catch (err) {
    // The resolver speaks in messages meant for the user; a single request can
    // say it plainly. A split adds which person it failed on.
    await reply(ctx, publicErrorMessage(err));
    return;
  }

  try {
    const row = await createPaymentRequest({
      requesterAccountId: siteAcc.id,
      // Rendered to the payer as "+<number>", so only a real phone belongs here
      requesterWa: mine.waPhone || null,
      recipient,
      fromLabel,
      amountEth,
      chainId: chain.chainId,
    });

    // The command is a marker the delivery layer renders per channel, so one
    // body serves whichever chat the payer reads it in.
    await notifyRequestTarget(
      ctx,
      recipient,
      [
        'You have a payment request on Flizy.',
        `${amountEth} ETH requested.`,
        '',
        'Review and pay: {{cmd:pay}}',
      ].join('\n')
    );

    await reply(
      ctx,
      [
        'Payment request created.',
        `Amount: ${amountEth} ETH`,
        `From: ${displaySafeLabel(fromLabel)}`,
        '',
        'They see it once that identity is on Flizy, then:',
        `  ${cmd(ctx, 'pay')}`,
        '',
        `Cancel anytime: ${cmd(ctx, 'requests')}`,
        `Id: ${String(row.id).slice(0, 8)}…`,
      ].join('\n')
    );
  } catch (err) {
    console.error('createPaymentRequest:', publicErrorMessage(err));
    await reply(ctx, 'Could not create request. Try again.');
  }
}

/**
 * collect 5 for rent | collect for team lunch
 *
 * Makes the pot and hands back the code, because the code is the whole product:
 * it is what gets pasted into the group chat. Nobody is asked for anything here
 * -- that is the difference from a split, and the reason a pot is a row.
 */
async function handleCollect(ctx, user, account, parsed) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  if (parsed.amountEth != null) {
    let targetWei;
    try {
      targetWei = ethers.parseEther(String(parsed.amountEth));
    } catch {
      await reply(ctx, `Invalid goal.\nExample: ${cmd(ctx, 'collect 5 for rent')}`);
      return;
    }
    if (targetWei <= 0n) {
      await reply(ctx, 'A goal has to be more than zero, or leave it out.');
      return;
    }
  }

  let pot;
  try {
    pot = await createPot({
      ownerAccountId: siteAcc.id,
      name: parsed.name,
      targetEth: parsed.amountEth != null ? String(parsed.amountEth) : null,
      chainId: chain.chainId,
    });
  } catch (err) {
    await reply(ctx, publicErrorMessage(err));
    return;
  }

  const goal = pot.target_eth == null
    ? 'No goal set. It collects until you close it.'
    : `Goal: ${formatEth(pot.target_eth)} ETH`;

  await reply(
    ctx,
    [
      `Pot open: ${displaySafeLabel(pot.name)}`,
      goal,
      '',
      'Share this code. Anyone can pay in:',
      `  ${cmd(ctx, `pay pot ${pot.code}`)}`,
      '',
      `Track it: ${cmd(ctx, `pot ${pot.code}`)}`,
    ].join('\n')
  );
}

/** Every pot this account opened, with what has landed in each. */
async function handlePotsList(ctx, user, account) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  const pots = await listPotsForAccount(siteAcc.id);
  const totals = await potTotals(pots.map((x) => x.id));
  await reply(ctx, formatPotsMenu(pots, totals));
}

/**
 * pot <code> -- readable by anyone holding the code, not only the organiser.
 * That is the point of a shared pot: contributors can check the running total
 * without asking the person holding the money.
 */
async function handlePotDetail(ctx, user, account, parsed) {
  const pot = await getPotByCode(parsed.code);
  if (!pot) {
    await reply(ctx, `No pot with code ${displaySafeLabel(parsed.code)}.`);
    return;
  }

  const siteAcc = await resolveLinkedSiteAccount(ctx, account);
  const totals = await potTotals([pot.id]);
  const contributions = await listPotContributions(pot.id);
  await reply(
    ctx,
    formatPotDetail(pot, totals.get(pot.id), contributions, {
      mine: Boolean(siteAcc?.id) && siteAcc.id === pot.owner_account_id,
    })
  );
}

/**
 * "pay pot <code>" with no amount: ask for one, and listen for the answer.
 *
 * The first version replied with a suggestion and registered nothing, so the
 * reply was dropped and the payer got silence -- the bot asked a question and
 * ignored it.
 *
 * The suggested figure is the pot's own goal where that fits under the per-send
 * cap, never a round "1": the original example suggested 1 ETH, which is ten
 * times maxSendEth, so following the bot's own instruction always failed.
 */
async function handlePayPotAsk(ctx, user, account, parsed) {
  // Checked before asking, not after answering. handlePayPot requires it too,
  // so without this an unlinked payer would be asked how much, reply, and only
  // then be told to link -- a second dead end behind the one this fixes.
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  const pot = await getPotByCode(parsed.code);
  if (!pot) {
    await reply(ctx, `No pot with code ${displaySafeLabel(parsed.code)}.`);
    return;
  }

  const totals = await potTotals([pot.id]);
  const t = totals.get(pot.id);
  const suggestion = suggestedPotAmount(pot, t);

  pendingPotPays.set(ctx.key, { code: pot.code, createdAt: Date.now() });
  await reply(
    ctx,
    [
      `How much into ${displaySafeLabel(pot.name)}?`,
      potProgressLine(pot, t),
      '',
      `Reply with an amount, like: ${suggestion}`,
      `Or all at once: ${cmd(ctx, `pay pot ${pot.code} ${suggestion}`)}`,
    ].join('\n')
  );
}

/**
 * An amount worth suggesting: what is left of the goal, clamped to the per-send
 * cap. Never more than Flizy would let them send in one go.
 */
function suggestedPotAmount(pot, totals) {
  const cap = Number(config.maxSendEth);
  if (pot.target_eth == null) return String(Math.min(0.01, cap));
  const left = Number(pot.target_eth) - Number(totals?.totalEth || 0);
  const want = left > 0 ? left : Number(pot.target_eth);
  return formatEth(String(Math.min(want, cap)));
}

/**
 * pay pot <code> 1.5
 *
 * Settles straight to the organiser wallet, exactly like paying a request. The
 * pot is tagged on the transfer so the total can be counted from it; it never
 * holds the money, so there is nothing to release and nothing to refund.
 */
async function handlePayPot(ctx, user, account, parsed) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  const pot = await getPotByCode(parsed.code);
  if (!pot) {
    await reply(ctx, `No pot with code ${displaySafeLabel(parsed.code)}.`);
    return;
  }
  if (pot.status !== POT_STATUS.OPEN) {
    await reply(
      ctx,
      [
        `${displaySafeLabel(pot.name)} is closed.`,
        'It is no longer collecting.',
      ].join('\n')
    );
    return;
  }
  if (pot.owner_account_id === siteAcc.id) {
    await reply(ctx, 'This is your own pot. Money you add would only move to yourself.');
    return;
  }

  const ownerAcc = await ensureAgentWallet(pot.owner_account_id);
  const toAddress = ownerAcc.agent_wallet_address;
  if (!toAddress) {
    await reply(ctx, 'That pot has no Flizy wallet yet.');
    return;
  }

  // skipTrusted for the same reason paying a request skips it: the allowlist
  // stops a compromised bot picking its own destination, not a person paying
  // into a pot they were handed the code for.
  await handleSendResolved(
    ctx,
    user,
    String(parsed.amountEth),
    { address: ethers.getAddress(toAddress), label: `pot ${pot.code} (${displaySafeLabel(pot.name)})` },
    siteAcc,
    { skipTrusted: true, potId: pot.id }
  );
}

/** Closing stops contributions. It moves nothing, because nothing is held. */
async function handleClosePot(ctx, user, account, parsed) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  const pot = await getPotByCode(parsed.code);
  if (!pot) {
    await reply(ctx, `No pot with code ${displaySafeLabel(parsed.code)}.`);
    return;
  }
  if (pot.owner_account_id !== siteAcc.id) {
    await reply(ctx, 'Only the person who opened a pot can close it.');
    return;
  }

  const closed = await closePot(pot.id, siteAcc.id);
  if (!closed) {
    await reply(ctx, 'That pot is already closed.');
    return;
  }

  const totals = await potTotals([pot.id]);
  await reply(
    ctx,
    [
      `Closed: ${displaySafeLabel(closed.name)}`,
      `Collected ${potProgressLine(closed, totals.get(pot.id))}`,
      '',
      'The money was already in your wallet as it came in.',
    ].join('\n')
  );
}

/** rename pot <code> <name> -- one of the three reasons a pot is a table. */
async function handleRenamePot(ctx, user, account, parsed) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  const pot = await getPotByCode(parsed.code);
  if (!pot) {
    await reply(ctx, `No pot with code ${displaySafeLabel(parsed.code)}.`);
    return;
  }
  if (pot.owner_account_id !== siteAcc.id) {
    await reply(ctx, 'Only the person who opened a pot can rename it.');
    return;
  }

  let renamed;
  try {
    renamed = await renamePot(pot.id, siteAcc.id, parsed.name);
  } catch (err) {
    await reply(ctx, publicErrorMessage(err));
    return;
  }
  if (!renamed) {
    await reply(ctx, 'Could not rename that pot.');
    return;
  }
  await reply(ctx, `Renamed to: ${displaySafeLabel(renamed.name)}`);
}

/**
 * split <total> with <people> [for <note>]
 *
 * The typed amount is the whole bill and it divides among the people named
 * **plus the organiser**, because that is what splitting a bill means at a
 * table. Thirty between you and two friends is ten each and two requests go
 * out; nobody asks the organiser for their own share.
 *
 * Division is in wei, so the shares are exact. Any remainder -- at most a few
 * wei -- stays with the organiser rather than being pushed onto one friend,
 * who would otherwise be the only person paying a different number to
 * everyone else for no reason they could see.
 *
 * Every person is resolved before a single request is written. A split that
 * fails halfway would leave some friends billed and others not, with no way
 * for the organiser to tell which.
 */
async function handleSplitBill(ctx, user, account, parsed) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  const { amountEth, people, note } = parsed;

  let totalWei;
  try {
    totalWei = ethers.parseEther(String(amountEth));
  } catch {
    await reply(ctx, `Invalid amount.\nExample: ${cmd(ctx, 'split 30 with @ada @kemi')}`);
    return;
  }
  if (totalWei <= 0n) {
    await reply(ctx, 'Split what? The total has to be more than zero.');
    return;
  }

  const ways = BigInt(people.length + 1);
  const shareWei = totalWei / ways;
  if (shareWei <= 0n) {
    await reply(
      ctx,
      [
        `${amountEth} ETH does not divide ${ways} ways.`,
        'Each share would round to nothing.',
      ].join('\n')
    );
    return;
  }

  const shareEth = ethers.formatEther(shareWei);
  if (Number(shareEth) > config.maxSendEth) {
    await reply(
      ctx,
      [
        `Each share would be ${formatEth(shareEth)} ETH.`,
        `Max per request is ${config.maxSendEth} ETH.`,
      ].join('\n')
    );
    return;
  }

  const mine = await resolveClaimIdentity(ctx);

  // Resolve everyone first: a half-written split is worse than none.
  const targets = [];
  for (const raw of people) {
    const shape = parseRequestCommand(`request ${shareEth} from ${raw}`);
    try {
      const target = await resolveRequestTarget({
        raw: shape ? shape.fromRaw : raw,
        kind: shape ? shape.kind || 'alias' : 'alias',
        platform: shape ? shape.platform : null,
        mine,
        siteAcc,
      });
      targets.push(target);
    } catch (err) {
      await reply(
        ctx,
        [
          `Could not split: ${publicErrorMessage(err)}`,
          `Nobody was asked for anything.`,
        ].join('\n')
      );
      return;
    }
  }

  const billId = randomUUID();
  const created = [];
  try {
    for (const target of targets) {
      const row = await createPaymentRequest({
        requesterAccountId: siteAcc.id,
        requesterWa: mine.waPhone || null,
        recipient: target.recipient,
        fromLabel: target.label,
        amountEth: shareEth,
        chainId: chain.chainId,
        billId,
        billNote: note,
      });
      created.push({ row, target });
    }
  } catch (err) {
    console.error('split bill:', publicErrorMessage(err));
    await reply(
      ctx,
      [
        `Asked ${created.length} of ${targets.length} before something went wrong.`,
        `Check and cancel: ${cmd(ctx, 'requests')}`,
      ].join('\n')
    );
    return;
  }

  const forLine = note ? ` for ${displaySafeLabel(note)}` : '';
  for (const { target } of created) {
    await notifyRequestTarget(
      ctx,
      target.recipient,
      [
        `You are in a split${forLine}.`,
        `Your share: ${formatEth(shareEth)} ETH.`,
        '',
        'Review and pay: {{cmd:pay}}',
      ].join('\n')
    );
  }

  await reply(
    ctx,
    [
      `Split ${formatEth(amountEth)} ETH ${ways} ways${forLine}.`,
      `Each share: ${formatEth(shareEth)} ETH`,
      '',
      `Asked ${created.length}:`,
      ...created.map(({ target }) => `  ${displaySafeLabel(target.label)}`),
      '',
      `Yours to cover: ${formatEth(ethers.formatEther(totalWei - shareWei * BigInt(created.length)))} ETH`,
      '',
      `Track or cancel: ${cmd(ctx, 'requests')}`,
    ].join('\n')
  );
}
async function handleRequestsCommand(ctx, user, account, kind) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  if (kind === 'incoming') {
    let rows;
    try {
      const identity = await resolveClaimIdentity(ctx);
      rows = await listIncomingRequests(identity);
    } catch (err) {
      console.error(publicErrorMessage(err));
      await reply(ctx, 'Could not load requests.');
      return;
    }
    if (!rows.length) {
      await reply(ctx, formatRequestsMenu([], 'incoming'));
      return;
    }
    if (rows.length === 1) {
      pendingClaimMenus.set(ctx.key, {
        mode: 'pay_request',
        requests: rows,
        createdAt: Date.now(),
        awaitConfirmId: rows[0].id,
      });
      await reply(
        ctx,
        [
          'Pay this request?',
          `${formatEth(requestRemainingEth(rows[0]))} ETH`,
          '',
          'Reply: confirm   pay it',
          '       0.01      pay part of it',
          '       decline   refuse, and tell them',
          '       cancel    leave it open',
        ].join('\n'),
        { buttons: confirmButtons() }
      );
      return;
    }
    pendingClaimMenus.set(ctx.key, { mode: 'pay_request', requests: rows, createdAt: Date.now() });
    await reply(ctx, formatRequestsMenu(rows, 'incoming'));
    return;
  }

  let rows;
  let bills = [];
  try {
    rows = await listOutgoingRequests(siteAcc.id);
    // Separate query on purpose: rows above are the pending ones that can still
    // be cancelled, and a bill's progress counts shares that are already settled
    // or refused. Deriving one from the other is what made "paid" always zero.
    bills = await summarizeBillsForAccount(siteAcc.id);
  } catch (err) {
    console.error(publicErrorMessage(err));
    await reply(ctx, 'Could not load requests.');
    return;
  }
  if (!rows.length) {
    // Still worth answering: every share may be settled, and "3 of 3 paid" is
    // the reply the organiser came for.
    await reply(ctx, formatRequestsMenu([], 'outgoing', bills));
    return;
  }
  if (rows.length === 1) {
    pendingClaimMenus.set(ctx.key, {
      mode: 'cancel_request',
      requests: rows,
      createdAt: Date.now(),
      awaitConfirmId: rows[0].id,
    });
    await reply(
      ctx,
      [
        'Cancel this request?',
        `${rows[0].amount_eth} ETH from ${requestPayerLabel(rows[0])}`,
        // One share left standing usually means the rest of the bill already
        // settled, and that is the context for deciding whether to cancel it.
        ...(billLines(bills).length ? ['', ...billLines(bills)] : []),
        '',
        'Reply: confirm',
        'Or: cancel',
      ].join('\n'),
      { buttons: confirmButtons() }
    );
    return;
  }
  pendingClaimMenus.set(ctx.key, { mode: 'cancel_request', requests: rows, createdAt: Date.now() });
  await reply(ctx, formatRequestsMenu(rows, 'outgoing', bills));
}

/**
 * How to name the person asking for money on the confirm screen.
 *
 * This preview used to read "To: request (0x1234…abcd)", which named nobody:
 * anyone who knows a phone number can raise a request, and the one screen
 * standing between that and the money never said who was asking.
 *
 * Display name first here, unlike senderLabel() which prefers the phone. A
 * received-money notice goes to somebody deciding whether they recognise a
 * number; this is a payer deciding whether they know a person, and the name is
 * what carries that. The name belongs to the requester, not the payer, so it is
 * sanitized: see displaySafeLabel.
 *
 * @param {object} req payment_requests row
 * @returns {Promise<string>} never empty, never the literal "request"
 */
async function requesterLabel(req) {
  const accountId = req?.requester_account_id || null;
  if (accountId) {
    try {
      const { data } = await supabase
        .from('accounts')
        .select('display_name')
        .eq('id', accountId)
        .maybeSingle();
      const name = displaySafeLabel(data?.display_name);
      if (name) return name;
    } catch (err) {
      console.warn('requesterLabel account:', publicErrorMessage(err));
    }
  }
  const phone = normalizeWaHint(req?.requester_wa || '');
  if (isPlausiblePhone(phone)) return `+${phone}`;
  // Honest, and still not a name the requester chose
  return 'unknown requester';
}

/**
 * @param {string|null} [payAmountEth] part payment. Null pays off whatever is
 *   still owed, which is what every caller meant when a request was all or
 *   nothing.
 */
/** Wei comparison for amounts that arrive as strings; 0n on anything unparseable. */
function toWeiSafe(amount) {
  try {
    return ethers.parseEther(String(amount ?? '0'));
  } catch {
    return 0n;
  }
}

async function startPayRequest(ctx, user, account, requestId, payAmountEth = null) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;
  const req = await getPaymentRequestById(requestId);
  if (!req || req.status !== 'pending') {
    await reply(ctx, 'That request is no longer pending.');
    return;
  }
  const identity = await resolveClaimIdentity(ctx);
  // Authorized the same way the menu is filled: a request is payable exactly
  // when it is one this identity can see. One matcher, so what is listed and
  // what is payable cannot disagree.
  //
  // This used to compare from_wa_hint against the account's phones, which was
  // right when phone was the only way to address a request. Since
  // 20260907000000 it is one of four, and the other three leave that column
  // null -- so every request made by @username, platform or email was listed,
  // notified, and then refused here as "a different phone number". Split bill
  // creates exactly those, so nothing it produced could ever be paid.
  const mine = await listIncomingRequests(identity);
  if (!mine.some((r) => r.id === req.id)) {
    const phoneAddressed = Boolean(normalizeWaHint(req.from_wa_hint));
    const noPhoneProven = !claimMatchKeysForAccount(identity).length;
    await reply(
      ctx,
      phoneAddressed && noPhoneProven
        ? `Could not verify your phone for this request. Send ${cmd(ctx, 'phone')}, then try again.`
        : 'That request was not addressed to you.'
    );
    return;
  }
  const requesterAcc = await ensureAgentWallet(req.requester_account_id);
  const toAddress = requesterAcc.agent_wallet_address;
  if (!toAddress) {
    await reply(ctx, 'Requester has no Flizy wallet yet.');
    return;
  }
  // skipTrusted stays. The allowlist exists so a compromised bot cannot pick its
  // own destination; it is not there to stop a user paying a named human who
  // asked them. Requiring the requester to be pre-trusted would make the feature
  // useless, since the point is being asked by somebody you have not paid yet.
  // What was missing is honesty on the screen, which requesterLabel and the
  // "not on your trusted list" line in formatPlanPreview now provide.
  // What is left, not what was asked: a request part-paid earlier must not
  // charge the full amount again.
  const owed = requestRemainingEth(req);
  let payNow = payAmountEth == null ? owed : String(payAmountEth);
  if (Number(payNow) <= 0) {
    await reply(ctx, 'Pay how much? Give an amount above zero.');
    return;
  }
  if (toWeiSafe(payNow) > toWeiSafe(owed)) {
    await reply(
      ctx,
      [
        `That is more than is owed. ${formatEth(owed)} ETH is outstanding.`,
        `To send extra, use ${cmd(ctx, 'send')} instead.`,
      ].join('\n')
    );
    return;
  }

  await handleSendResolved(
    ctx,
    user,
    payNow,
    { address: ethers.getAddress(toAddress), label: await requesterLabel(req) },
    siteAcc,
    { skipTrusted: true, paymentRequestId: req.id, payAmountEth: payNow }
  );
}

/**
 * remind | remind 2 -- nudge whoever still owes on a request you made.
 *
 * The rate limit lives in the row, not here, so a bot restart cannot reset it:
 * the nudge lands on somebody else's phone and they did not ask for it. A
 * request already past its cooldown is skipped silently in the bare form,
 * because "remind everyone" meaning "remind the three who are due" is what the
 * organiser wants; naming each skip would bury the useful line.
 */
async function handleRemind(ctx, user, account, parsed) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  let rows;
  try {
    rows = await listOutgoingRequests(siteAcc.id);
  } catch (err) {
    console.error('remind list:', publicErrorMessage(err));
    await reply(ctx, 'Could not load your requests.');
    return;
  }
  if (!rows.length) {
    await reply(ctx, 'Nothing to remind about. Nobody owes you on Flizy.');
    return;
  }

  let targets = rows;
  if (parsed.index != null) {
    const idx = parsed.index - 1;
    if (idx < 0 || idx >= rows.length) {
      await reply(ctx, `Pick 1-${rows.length}. See them with ${cmd(ctx, 'requests')}`);
      return;
    }
    targets = [rows[idx]];
  }

  const nudged = [];
  let tooSoon = 0;
  for (const row of targets) {
    let result;
    try {
      result = await remindRequest(row.id, siteAcc.id);
    } catch (err) {
      console.error('remind:', publicErrorMessage(err));
      continue;
    }
    if (!result.ok) {
      if (result.reason === 'too_soon') tooSoon += 1;
      continue;
    }
    const recipient = requestRecipientFromRow(row);
    if (!recipient) continue;
    try {
      await notifyRequestTarget(
        ctx,
        recipient,
        formatRequestReminderNotice({
          byLabel: await senderLabel(ctx, siteAcc.id, null),
          amountEth: requestRemainingEth(row),
          billNote: row.bill_note || null,
        })
      );
      nudged.push(row);
    } catch (err) {
      console.warn('remind notify:', publicErrorMessage(err));
    }
  }

  if (!nudged.length) {
    await reply(
      ctx,
      tooSoon
        ? 'Already reminded recently. Give it a few hours.'
        : 'Nobody could be reminded right now.'
    );
    return;
  }

  const lines = [`Reminded ${nudged.length === 1 ? '1 person' : `${nudged.length} people`}.`];
  for (const r of nudged) {
    lines.push(`  ${requestPayerLabel(r)}  ${requestRemainingEth(r)} ETH`);
  }
  if (tooSoon) {
    lines.push('', `${tooSoon} skipped, reminded too recently.`);
  }
  await reply(ctx, lines.join('\n'));
}

/**
 * Refuse a request addressed to this person, and tell the one who asked.
 *
 * The mirror of runCancelOneRequest: that one is the asker withdrawing, this is
 * the person asked refusing. Both are terminal and neither moves money, which
 * is why the notice says so outright -- an organiser who reads "declined" on a
 * money path will otherwise go looking for a refund that never existed.
 */
async function runDeclineOneRequest(ctx, user, account, requestId) {
  let result;
  try {
    const identity = await resolveClaimIdentity(ctx);
    result = await declinePaymentRequest(requestId, identity);
  } catch (err) {
    console.error('decline request:', publicErrorMessage(err));
    await reply(ctx, 'Could not decline that request. Try again shortly.');
    return;
  }

  if (!result.ok) {
    const said = {
      not_found: 'That request no longer exists.',
      not_pending: 'That request is already settled.',
      not_yours: 'That request was not addressed to you.',
      unavailable: 'Declining is not available yet.',
    };
    await reply(ctx, said[result.reason] || 'Could not decline that request.');
    return;
  }

  const row = result.request;
  await reply(
    ctx,
    [
      `Declined ${formatEth(row.amount_eth)} ETH.`,
      'Nothing moved. They have been told.',
    ].join('\n')
  );

  // Best effort: the decline is already recorded, so a failed notify must not
  // read to the payer as if nothing happened.
  const requesterId = row.requester_account_id;
  if (!requesterId) return;
  try {
    const byLabel = await senderLabel(ctx, account?.id || null, null);
    await notifyAccount(
      requesterId,
      formatRequestDeclinedNotice({
        amountEth: row.amount_eth,
        byLabel,
        billNote: row.bill_note || null,
      }),
      { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
    );
  } catch (err) {
    console.warn('request declined notify:', publicErrorMessage(err));
  }
}

async function runCancelOneRequest(ctx, account, requestId) {
  const siteAcc = await resolveLinkedSiteAccount(ctx, account);
  if (!siteAcc?.id) {
    await reply(ctx, 'Link your site account first.');
    return;
  }
  const result = await cancelPaymentRequest(requestId, siteAcc.id);
  if (!result.ok) {
    await reply(ctx, 'Could not cancel (already paid or not yours).');
    return;
  }
  await reply(ctx, 'Request cancelled.');
}

/**
 * Detach this chat (or a named chat channel) from the Flizy account.
 * Being in the chat proves control of that channel for "unlink" / "unlink this".
 * Unlinking the other chat app is only allowed when both are on the same account.
 */
async function handleUnlink(ctx, scope) {
  discardPendingFlows(ctx.key);
  const siteAcc = await resolveLinkedSiteAccount(ctx, null);
  if (!siteAcc?.id) {
    await reply(
      ctx,
      [
        'This chat is not linked to a Flizy account.',
        `Link first: ${cmd(ctx, 'link CODE')} from the dashboard.`,
      ].join('\n')
    );
    return;
  }

  let channel = ctx.channel;
  if (scope === 'whatsapp' || scope === 'telegram') {
    channel = scope;
    if (channel !== ctx.channel) {
      // Only allow unlinking the other chat if it is on the same account
      try {
        const rows = await listIdentitiesForAccount(siteAcc.id);
        const other = rows.find((r) => r.channel === channel);
        if (!other) {
          await reply(ctx, `${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} is not linked on your account.`);
          return;
        }
      } catch (err) {
        console.warn('unlink list:', publicErrorMessage(err));
        await reply(ctx, 'Could not check linked chats. Try again shortly.');
        return;
      }
    }
  } else {
    channel = ctx.channel;
  }

  const where = channel === 'whatsapp' ? 'WhatsApp' : channel === 'telegram' ? 'Telegram' : channel;

  try {
    const res = await unlinkChannelIdentity(getSupabase(), {
      accountId: siteAcc.id,
      channel,
    });
    if (!res.removed) {
      await reply(ctx, `${where} was not linked on your account.`);
      return;
    }
    await reply(
      ctx,
      [
        `${where} unlinked from Flizy.`,
        'Phone claims no longer match via this chat until you link again.',
        channel === ctx.channel
          ? `To re-link: generate a code on the site, then ${cmd(ctx, 'link CODE')}.`
          : 'You can still use this chat if it remains linked.',
      ].join('\n')
    );
  } catch (err) {
    if (err instanceof BindError) {
      await reply(ctx, err.message || 'Could not unlink.');
      return;
    }
    console.error('unlink:', publicErrorMessage(err));
    await reply(ctx, 'Could not unlink. Try again shortly.');
  }
}

/**
 * Bind this chat identity to the account that generated the code.
 * The code is the identity proof: only a logged-in account holder can make one.
 */
async function handleLink(ctx, code) {
  discardPendingFlows(ctx.key);
  try {
    let verifiedPhone = null;
    if (typeof ctx.resolveVerifiedPhone === 'function') {
      try {
        verifiedPhone = await ctx.resolveVerifiedPhone();
      } catch (err) {
        console.warn('resolveVerifiedPhone:', publicErrorMessage(err));
      }
    }

    // The code itself is a credential that binds a chat app to an account, so it
    // is masked here for the same reason an unlock secret is never logged.
    console.log(
      `[link] attempt channel=${ctx.channel} id=${maskPhone(ctx.externalId)} phone=${
        verifiedPhone ? maskPhone(verifiedPhone) : 'none'
      } code=${maskLinkCode(code)}`
    );

    const result = await consumeLinkCode(ctx.channel, ctx.externalId, code, verifiedPhone, {
      // Telegram username (when present) is display-only; claims match on user id.
      displayHandle: ctx.displayHandle || null,
    });

    if (!result.ok) {
      if (result.reason === 'locked_out') {
        await reply(
          ctx,
          [
            'Too many wrong link codes from this chat.',
            `Try again in about ${result.retryAfterText || 'a while'}.`,
            '',
            'A code is only valid for 10 minutes. Open the Flizy site and',
            'generate a fresh one rather than retyping an old one.',
          ].join('\n')
        );
        return;
      }
      if (result.reason === 'used') {
        // The common case by far: one code, two buttons on the dashboard. Say
        // which chat app spent it, because "invalid" sent people hunting for a
        // typo that was never there.
        const spentOn =
          result.usedByChannel === 'whatsapp'
            ? 'WhatsApp'
            : result.usedByChannel === 'telegram'
              ? 'Telegram'
              : 'another chat';
        await reply(
          ctx,
          [
            `That code was already used to link ${spentOn}.`,
            '',
            'Each code works once. Open the Flizy site, generate a new one,',
            `and use it here first: ${cmd(ctx, 'link CODE')}`,
          ].join('\n')
        );
        return;
      }
      if (result.reason === 'expired') {
        await reply(ctx, 'That link code expired. Generate a new one on the Flizy site.');
        return;
      }
      if (result.reason === 'phone_bound_elsewhere') {
        await reply(
          ctx,
          [
            'Not linked.',
            'This phone number is already on a different Flizy account.',
            '',
            'One number belongs to one account. Log in to that account on the site,',
            'or remove the number there first, then link again.',
          ].join('\n')
        );
        return;
      }
      const tail =
        result.lockedForMs > 0
          ? `\nToo many wrong codes. Wait about ${result.retryAfterText} before trying again.`
          : result.attemptsLeft != null && result.attemptsLeft <= 2
            ? `\nTries left before a timeout: ${result.attemptsLeft}`
            : '';
      await reply(
        ctx,
        `Invalid link code. Open the Flizy site and generate a fresh link.${tail}`
      );
      return;
    }

    const acc = await ensureAgentWallet(result.account.id);
    const { user } = await resolveLegacyUser(ctx, acc.id);

    // Keep the legacy ledger row aligned with the site account
    await supabase
      .from('users')
      .update({
        account_id: acc.id,
        balance_eth: acc.balance_eth ?? 0,
        is_admin: Boolean(acc.is_admin),
        wallet_address: acc.agent_wallet_address,
      })
      .eq('id', user.id);

    console.log(
      `[link] ok channel=${ctx.channel} id=${maskPhone(ctx.externalId)} account=${acc.id}`
    );

    const linkedFlag = ctx.channel === 'telegram' ? 'telegram=linked' : 'whatsapp=linked';
    const returnUrl = `${config.siteUrl}/dashboard/account?s=chat&${linkedFlag}`;
    const openButtons =
      ctx.channel === 'telegram'
        ? { buttons: [[{ label: 'Open Flizy', url: returnUrl }]] }
        : undefined;

    await reply(
      ctx,
      [
        `${channelName(ctx)} connected to Flizy.`,
        '',
        'Your Flizy account',
        acc.email ? `Email: ${acc.email}` : null,
        acc.display_name ? `Name: ${acc.display_name}` : null,
        `Flizy wallet: ${acc.agent_wallet_address || 'pending'}`,
        `${channelName(ctx)} id: ${ctx.externalId}`,
        '',
        'Commands',
        `  ${cmd(ctx, 'me')}`,
        `  ${cmd(ctx, 'balance')}`,
        `  ${cmd(ctx, 'add wallet 0x...')}`,
        `  ${cmd(ctx, 'send 0.0001 to john')}`,
        '  confirm',
        '',
        `Open your account: ${returnUrl}`,
        `Reply with ${cmd(ctx, 'me')} to confirm.`,
      ]
        .filter(Boolean)
        .join('\n'),
      openButtons
    );

    // Claims are addressed by phone. Ask for a verified number when we lack one.
    if (!result.phone && typeof ctx.requestPhone === 'function') {
      await ctx.requestPhone(
        [
          'One more step to receive money sent to your phone number.',
          '',
          'Tap the button below to share your number.',
          'Telegram verifies it; a typed number is never accepted.',
          'Skip this and you can still send, swap and pay requests.',
        ].join('\n')
      );
    }

    await notifyIncomingAfterLink(ctx);
  } catch (err) {
    console.error('link error:', publicErrorMessage(err));
    await reply(ctx, 'Could not link right now. Try a new code from the site.');
  }
}

/**
 * A channel-verified phone arrived (Telegram contact share).
 * The only path that writes a claim phone from a chat.
 *
 * @param {object} ctx
 * @param {{ phone: string, verified: boolean }} shared
 */
async function handleSharedPhone(ctx, shared) {
  if (!shared || !shared.verified) {
    await reply(
      ctx,
      'Use the Share number button so your number can be verified. A typed number is not accepted.'
    );
    return;
  }

  const phone = normalizePhoneNumber(shared.phone);
  if (!isPlausiblePhone(phone)) {
    await reply(ctx, 'That number does not look valid. Try the share button again.');
    return;
  }

  const bound = await getAccountByIdentity(ctx.channel, ctx.externalId);
  if (!bound?.account?.id) {
    await reply(
      ctx,
      `Link your Flizy account first, then share your number.\n${cmd(ctx, 'link CODE')}`
    );
    return;
  }

  // Clients call this straight from a contact-share tap, so it never passes
  // through handle() and its lock gate. It is still a step of a flow the bot
  // started, and it decides which number's claims land in this account, so it
  // gets the same gate.
  if (await isSessionHardLocked(bound.account.id, ctx.channel, ctx.externalId)) {
    await reply(
      ctx,
      `Session locked. Nothing was saved.\nSend: ${cmd(ctx, 'unlock')}\nThen share your number again.`
    );
    return;
  }

  const res = await setIdentityPhone(ctx.channel, ctx.externalId, phone);
  if (!res.ok) {
    if (res.reason === 'phone_taken') {
      await reply(
        ctx,
        [
          'Not saved.',
          'This number is already on a different Flizy account.',
          '',
          'One number belongs to one account. Use that account, or remove the number there first.',
        ].join('\n')
      );
      return;
    }
    await reply(ctx, 'Could not save that number. Try again.');
    return;
  }

  await reply(
    ctx,
    [
      'Number verified.',
      `Claims and requests sent to +${res.phone} now reach you here.`,
      '',
      `Check now: ${cmd(ctx, 'claim')}`,
    ].join('\n')
  );

  await notifyIncomingAfterLink(ctx);
}

async function handleSaveContact(ctx, user, alias, address) {
  try {
    const saved = await saveContact(user, ctx.externalId, alias, address);
    await reply(
      ctx,
      [
        'Contact saved.',
        `  ${saved.alias} → ${saved.address}`,
        '',
        `Now you can: ${cmd(ctx, `send 0.001 to ${saved.alias}`)}`,
        `List all: ${cmd(ctx, 'contacts')}`,
      ].join('\n')
    );
  } catch (err) {
    await reply(ctx, `Could not save contact: ${err.message}`);
  }
}

async function handleRemoveContact(ctx, account, alias) {
  try {
    const owners = await ownerKeysForAccount(ctx, account?.id || null);
    const removed = await removeContact(owners, alias);
    if (!removed) {
      await reply(ctx, `No contact named "${alias}". Send ${cmd(ctx, 'contacts')} to list.`);
      return;
    }
    await reply(ctx, `Removed contact "${alias}".`);
  } catch (err) {
    await reply(ctx, `Could not remove contact: ${err.message}`);
  }
}

async function handleContactsList(ctx, account) {
  try {
    const owners = await ownerKeysForAccount(ctx, account?.id || null);
    const rows = await listContacts(owners);
    if (!rows.length) {
      await reply(
        ctx,
        [
          'No contacts yet.',
          `Save one: ${cmd(ctx, 'save ama 0xYourAddressHere')}`,
          `Then: ${cmd(ctx, 'send 0.001 to ama')}`,
        ].join('\n')
      );
      return;
    }
    const lines = ['Your contacts:'];
    for (const row of rows) {
      lines.push(`  ${row.alias} → ${row.address}`);
    }
    lines.push('', `Send: ${cmd(ctx, `send 0.001 to ${rows[0].alias}`)}`);
    await reply(ctx, lines.join('\n'));
  } catch (err) {
    await reply(ctx, `Could not list contacts: ${err.message}`);
  }
}

async function handlePhoneShare(ctx, account) {
  const bound = await getAccountByIdentity(ctx.channel, ctx.externalId);
  if (!bound?.account?.id) {
    await reply(
      ctx,
      `Link your Flizy account first.\n${cmd(ctx, 'link CODE')}`
    );
    return;
  }
  if (bound.identity?.phone_e164) {
    await reply(
      ctx,
      [
        `Your number is already verified: +${bound.identity.phone_e164}`,
        `Claims to it reach you here. Check: ${cmd(ctx, 'claim')}`,
      ].join('\n')
    );
    return;
  }
  if (typeof ctx.requestPhone !== 'function') {
    await reply(
      ctx,
      'This channel reads your number automatically. Nothing to share.'
    );
    return;
  }
  await ctx.requestPhone(
    [
      'Share your number so money sent to it reaches you here.',
      '',
      'Tap the button below. Telegram verifies the number;',
      'a typed number is never accepted.',
    ].join('\n')
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Handle one inbound chat message.
 * Clients call this after their own channel filters (groups, echoes, spam).
 *
 * @param {object} ctx
 * @param {string} rawText
 */
async function handle(ctx, rawText) {
  try {
    pruneExpiredPending();

    const normalized = normalizeInput(ctx, rawText);
    if (!normalized) {
      if (isTelegram(ctx)) {
        await reply(ctx, `Not a Flizy command. Send ${cmd(ctx, 'help')} for the list.`);
      }
      return;
    }
    const text = normalized.text;

    // Never log the body of an unlock exchange: that message IS the password.
    const verb = text.split(/\s+/)[0].toLowerCase();
    const secretish = pendingUnlocks.has(ctx.key) || verb === 'unlock';
    console.log(
      `[msg] ${ctx.key} ${secretish ? 'cmd=unlock <secret hidden>' : `body=${JSON.stringify(text.slice(0, 120))}`}`
    );

    // Link FIRST, before auto-creating a competing account for this identity.
    // A link also ends any name step that was open, the way it always has.
    const linkCmd = parseLinkCommand(text);
    if (linkCmd) {
      pendingWalletAdds.delete(ctx.key);
      await handleLink(ctx, linkCmd.code);
      return;
    }

    let user;
    let isNew = false;
    let account = null;
    try {
      const bridged = await getOrCreateAccountForIdentity(ctx.channel, ctx.externalId);
      account = bridged.account;
      const resolved = await resolveLegacyUser(ctx, account?.id || null);
      user = resolved.user;
      isNew = resolved.isNew;
    } catch (err) {
      console.error('identity bridge error:', publicErrorMessage(err));
      await reply(ctx, 'Database error registering you. Try again shortly.');
      return;
    }

    // Lock (no password). Above the unlock paths on purpose: while the bot is
    // waiting for a secret, the next message is read as that secret, and "lock"
    // is a safety action that must never be swallowed as a wrong guess.
    if (parseLockCommand(text)) {
      discardPendingFlows(ctx.key);
      if (!account?.id) {
        await reply(
          ctx,
          `Link your site account first, then lock.\nOpen the dashboard and send: ${cmd(ctx, 'link CODE')}`
        );
        return;
      }
      try {
        await lockSession(account.id, ctx.channel, ctx.externalId);
      } catch (lockErr) {
        console.error('lockSession failed:', publicErrorMessage(lockErr));
        await reply(ctx, 'Could not lock session right now. Try again in a moment.');
        return;
      }
      await reply(
        ctx,
        [
          `Session locked on ${channelName(ctx)}.`,
          'Other commands will not run here until you unlock.',
          `Unlock: ${cmd(ctx, 'unlock')}`,
          'Then reply with your password or PIN when asked.',
        ].join('\n')
      );
      return;
    }

    // Interactive unlock reply (plain secret, no prefix)
    if (pendingUnlocks.has(ctx.key)) {
      const wait = pendingUnlocks.get(ctx.key);
      if (Date.now() - wait.createdAt > PENDING_TTL_MS) {
        pendingUnlocks.delete(ctx.key);
        await reply(ctx, `Unlock timed out. Send: ${cmd(ctx, 'unlock')}`);
        return;
      }
      const unlockAgain = parseUnlockCommand(text);
      if (unlockAgain && unlockAgain.pin == null) {
        await reply(
          ctx,
          'Reply with your account password or unlock PIN.\n(Send only the secret as the next message.)'
        );
        return;
      }
      const secret =
        unlockAgain && unlockAgain.pin != null ? unlockAgain.pin : String(text || '').trim();

      if (!account?.id) {
        pendingUnlocks.delete(ctx.key);
        await reply(
          ctx,
          `Link your site account first, then unlock.\nOpen the dashboard and send: ${cmd(ctx, 'link CODE')}`
        );
        return;
      }
      pendingUnlocks.delete(ctx.key);
      const res = await unlockWithPin(account, ctx.channel, ctx.externalId, secret);
      if (!res.ok && (res.reason === 'no_pin' || res.reason === 'no_account')) {
        await reply(
          ctx,
          `No password or PIN on this account.\nSet a PIN on the site: ${config.siteUrl}/dashboard/account`
        );
        return;
      }
      if (!res.ok) {
        await reply(ctx, unlockFailureText(ctx, res));
        return;
      }
      await reply(
        ctx,
        `Session unlocked on ${channelName(ctx)}.\nCommands work again for about 1 hour of activity.\nLock anytime: ${cmd(ctx, 'lock')}`
      );
      return;
    }

    // Unlock: prompt or one-shot secret
    const unlockCmd = parseUnlockCommand(text);
    if (unlockCmd) {
      if (!account?.id) {
        await reply(
          ctx,
          `Link your site account first.\nOpen the dashboard and send: ${cmd(ctx, 'link CODE')}`
        );
        return;
      }
      if (unlockCmd.pin == null || unlockCmd.pin === '') {
        pendingUnlocks.set(ctx.key, { createdAt: Date.now() });
        await reply(
          ctx,
          [
            `Unlock Flizy on this ${channelName(ctx)}.`,
            'Reply with your site login password or unlock PIN.',
            'Send only the secret as the next message.',
          ].join('\n')
        );
        return;
      }
      const res = await unlockWithPin(account, ctx.channel, ctx.externalId, unlockCmd.pin);
      if (!res.ok && (res.reason === 'no_pin' || res.reason === 'no_account')) {
        await reply(
          ctx,
          `No password or PIN on this account.\nSet a PIN on the site: ${config.siteUrl}/dashboard/account`
        );
        return;
      }
      if (!res.ok) {
        await reply(ctx, unlockFailureText(ctx, res));
        return;
      }
      await reply(
        ctx,
        `Session unlocked on ${channelName(ctx)}.\nCommands work again for about 1 hour of activity.\nLock anytime: ${cmd(ctx, 'lock')}`
      );
      return;
    }

    // Hard lock gate: only unlock / link may run while locked
    if (!isAdminUser(user) && account?.id) {
      const hardLocked = await isSessionHardLocked(account.id, ctx.channel, ctx.externalId);
      if (hardLocked && !isAllowedWhenLocked(text)) {
        await reply(
          ctx,
          `Session locked.\nSend: ${cmd(ctx, 'unlock')}\nThen reply with your password or PIN.`
        );
        return;
      }
      try {
        const row = await getSession(account.id, ctx.channel, ctx.externalId);
        if (row && !row.is_locked && new Date(row.expires_at).getTime() > Date.now()) {
          await touchSession(account.id, ctx.channel, ctx.externalId);
        }
      } catch {
        /* ignore */
      }
    }

    // Finish "add wallet" name step (a bare reply like "john" is allowed).
    //
    // Below the hard-lock gate on purpose. This used to sit at the top of the
    // router, so a trusted-wallet-add started before the session locked could
    // still be finished while it was locked, which is a new payout destination
    // added by whoever was holding the phone. Every pending flow now resumes
    // behind the gate, and locking discards them anyway.
    if (pendingWalletAdds.has(ctx.key)) {
      const pendingAdd = pendingWalletAdds.get(ctx.key);
      const nameCandidate = text;

      if (isCancelCommand(nameCandidate)) {
        pendingWalletAdds.delete(ctx.key);
        await reply(ctx, 'Cancelled.');
        return;
      }

      // Never treat our own prompt copy as a label
      const lower = nameCandidate.trim().toLowerCase();
      if (
        lower === 'name' ||
        lower.startsWith('what should we call') ||
        lower.startsWith('added ') ||
        lower.startsWith('reply with one word')
      ) {
        return;
      }

      const looksLikeNewCommand =
        Boolean(parseAddWalletCommand(nameCandidate)) ||
        Boolean(parseSendCommand(nameCandidate)) ||
        Boolean(parseLinkCommand(nameCandidate)) ||
        isHelpCommand(nameCandidate) ||
        isBalanceCommand(nameCandidate) ||
        isMeCommand(nameCandidate) ||
        isHistoryCommand(nameCandidate) ||
        isDepositCommand(nameCandidate) ||
        isConfirmCommand(nameCandidate);

      if (!looksLikeNewCommand) {
        const chosen = nameCandidate.trim();
        if (!isValidTrustedName(chosen)) {
          await reply(
            ctx,
            'Name must start with a letter (a-z), then letters/numbers/_ only.\nExample: john\nOr: cancel'
          );
          return;
        }
        try {
          const bridged = await getOrCreateAccountForIdentity(ctx.channel, ctx.externalId);
          const acc = await ensureAgentWallet(bridged.account.id);
          await resolveLegacyUser(ctx, acc.id);
          await addTrusted(acc.id, pendingAdd.address, chosen.toLowerCase());
          pendingWalletAdds.delete(ctx.key);
          await reply(ctx, `Added ${chosen.toLowerCase()}`);
        } catch (err) {
          console.error('add wallet name step:', publicErrorMessage(err));
          pendingWalletAdds.delete(ctx.key);
          await reply(ctx, 'Could not add wallet. Try again.');
        }
        return;
      }
      pendingWalletAdds.delete(ctx.key);
    }

    // A first-ever message gets the welcome. When that message was itself a
    // request for help, the command list still has to follow it: returning here
    // left a new user staring at a greeting with no commands in it.
    if (isNew) {
      await reply(ctx, welcomeText(ctx, user, await welcomeState(ctx, account)));
    }

    if (isHelpCommand(text)) {
      await reply(ctx, helpText(ctx));
      return;
    }

    if (isInviteCommand(text)) {
      await handleInvite(ctx, account);
      return;
    }

    if (isHowCommand(text)) {
      await reply(ctx, howOthersUseText(ctx));
      return;
    }

    if (isMeCommand(text)) {
      await handleMe(ctx, user, account);
      return;
    }

    if (isPhoneShareCommand(text)) {
      await handlePhoneShare(ctx, account);
      return;
    }

    if (isDepositCommand(text)) {
      await handleDeposit(ctx, user, account);
      return;
    }

    if (isBalanceCommand(text)) {
      await handleBalance(ctx, user, account);
      return;
    }

    if (isHistoryCommand(text)) {
      await handleHistory(ctx, account);
      return;
    }

    if (isContactsListCommand(text)) {
      await handleContactsList(ctx, account);
      return;
    }

    if (isPoolCommand(text)) {
      await handlePool(ctx, user);
      return;
    }

    if (isEscrowCommand(text)) {
      await handleEscrow(ctx, user);
      return;
    }

    if (isUsersCommand(text)) {
      await handleUsers(ctx, user);
      return;
    }

    const addWalletCmd = parseAddWalletCommand(text);
    if (addWalletCmd) {
      if (!ethers.isAddress(addWalletCmd.address)) {
        await reply(ctx, 'Invalid address. Use a full 0x wallet address.');
        return;
      }
      const checksum = ethers.getAddress(addWalletCmd.address);
      pendingSends.delete(ctx.key);
      pendingWalletAdds.set(ctx.key, { address: checksum, createdAt: Date.now() });
      await reply(
        ctx,
        [
          'What should we call this wallet?',
          `Address: ${shortAddress(checksum)}`,
          '',
          'Reply with ONE word you choose (example: john)',
          'Or: cancel',
        ].join('\n')
      );
      return;
    }

    const saveCmd = parseSaveContactCommand(text);
    if (saveCmd) {
      await handleSaveContact(ctx, user, saveCmd.alias, saveCmd.address);
      return;
    }

    const removeCmd = parseRemoveContactCommand(text);
    if (removeCmd) {
      await handleRemoveContact(ctx, account, removeCmd.alias);
      return;
    }

    const claimAdmin = parseClaimAdminCommand(text);
    if (claimAdmin) {
      await handleClaimAdmin(ctx, user, claimAdmin.secret);
      return;
    }

    const creditCmd = parseCreditCommand(text);
    if (creditCmd) {
      await handleCredit(ctx, user, creditCmd.phone, creditCmd.amountEth);
      return;
    }

    // Claim / request menus (1, 2, All, confirm)
    if (pendingClaimMenus.has(ctx.key)) {
      const handledMenu = await handleClaimMenuReply(ctx, user, account, text);
      if (handledMenu) return;
    }

    // Answer to a direction question ("trade 100 flz" → 1 or 2)
    if (pendingChoices.has(ctx.key)) {
      const handledChoice = await handleChoiceReply(ctx, user, account, text);
      if (handledChoice) return;
    }

    if (pendingNamedSends.has(ctx.key)) {
      const waiting = pendingNamedSends.get(ctx.key);
      if (isCancelCommand(text)) {
        pendingNamedSends.delete(ctx.key);
        await reply(ctx, 'Cancelled.');
        return;
      }
      const amt = String(text || '').trim();
      const isAmount = /^[0-9]*\.?[0-9]+$/.test(amt) && Number(amt) > 0;
      if (!isAmount) {
        // Changing your mind mid-question is not a wrong answer. A real
        // command drops the half-finished send and runs, the way the
        // add-wallet name step already works; anything else is re-asked,
        // so a stray message cannot silently abandon the flow either.
        if (isFlizyCommandBody(text)) {
          pendingNamedSends.delete(ctx.key);
        } else {
          await reply(ctx, 'Reply with an amount, or: cancel');
          return;
        }
      } else {
        pendingNamedSends.delete(ctx.key);
        await handleSend(
          ctx,
          user,
          account,
          amt,
          waiting.dest.toRaw,
          Boolean(waiting.dest.isAddress),
          Boolean(waiting.dest.isPhone),
          String(waiting.ticker || 'ETH').toUpperCase(),
          waiting.dest.platform || null,
          Boolean(waiting.dest.isEmail)
        );
        return;
      }
    }

    const unlinkCmd = parseUnlinkCommand(text);
    if (unlinkCmd) {
      await handleUnlink(ctx, unlinkCmd.scope);
      return;
    }

    const cancelClaims = parseCancelClaimsCommand(text);
    if (cancelClaims) {
      await handleCancelClaims(ctx, user, account, cancelClaims.filter);
      return;
    }

    const claimsList = parseClaimsListCommand(text);
    if (claimsList) {
      await handleClaimsList(ctx, user, account, claimsList.kind);
      return;
    }

    // Pots come before the generic pay paths: "pay pot k7m2q4 1" must not be
    // read as paying an account whose name happens to be "pot".
    const payPot = parsePayPotCommand(text);
    if (payPot) {
      await handlePayPot(ctx, user, account, payPot);
      return;
    }

    const payPotNoAmount = parsePayPotNoAmountCommand(text);
    if (payPotNoAmount) {
      await handlePayPotAsk(ctx, user, account, payPotNoAmount);
      return;
    }

    const collectCmd = parseCollectCommand(text);
    if (collectCmd) {
      await handleCollect(ctx, user, account, collectCmd);
      return;
    }

    const closePotCmd = parseClosePotCommand(text);
    if (closePotCmd) {
      await handleClosePot(ctx, user, account, closePotCmd);
      return;
    }

    const renamePotCmd = parseRenamePotCommand(text);
    if (renamePotCmd) {
      await handleRenamePot(ctx, user, account, renamePotCmd);
      return;
    }

    const potCmd = parsePotCommand(text);
    if (potCmd) {
      await handlePotDetail(ctx, user, account, potCmd);
      return;
    }

    if (parsePotsListCommand(text)) {
      await handlePotsList(ctx, user, account);
      return;
    }

    const splitCmd = parseSplitCommand(text);
    if (splitCmd) {
      await handleSplitBill(ctx, user, account, splitCmd);
      return;
    }

    const reqCmd = parseRequestCommand(text);
    if (reqCmd) {
      await handleRequestMoney(ctx, user, account, reqCmd);
      return;
    }

    const remindCmd = parseRemindCommand(text);
    if (remindCmd) {
      await handleRemind(ctx, user, account, remindCmd);
      return;
    }

    const requestsCmd = parseRequestsCommand(text);
    if (requestsCmd) {
      await handleRequestsCommand(ctx, user, account, requestsCmd.kind);
      return;
    }

    if (isCancelCommand(text)) {
      await handleCancel(ctx);
      return;
    }

    if (pendingMerchantSaves.has(ctx.key)) {
      const t = String(text || '').trim().toLowerCase();
      if (t === 'save' || t === 'yes' || t.startsWith('save ')) {
        const pending = pendingMerchantSaves.get(ctx.key);
        pendingMerchantSaves.delete(ctx.key);
        const siteAcc = await requireLinkedSite(ctx, account);
        if (!siteAcc) return;
        try {
          await addTrusted(siteAcc.id, pending.address, pending.label);
          await reply(
            ctx,
            [
              `Saved ${pending.label}.`,
              `Next time: ${cmd(ctx, `send 0.01 to ${pending.label}`)}`,
            ].join('\n')
          );
        } catch (err) {
          await reply(ctx, `Could not save: ${publicErrorMessage(err)}`);
        }
        return;
      }
      if (t === 'skip' || t === 'no' || t === 'later') {
        pendingMerchantSaves.delete(ctx.key);
        await reply(ctx, 'Not saved.');
        return;
      }
    }

    if (isConfirmCommand(text)) {
      if (pendingClaimMenus.has(ctx.key)) {
        await handleClaimMenuReply(ctx, user, account, text);
        return;
      }
      await handleConfirm(ctx, user, account);
      return;
    }

    const swapCmd = parseSwapCommand(text);
    if (swapCmd) {
      await handleSwapCommand(ctx, user, account, swapCmd);
      return;
    }

    // --- Paste-first buy -------------------------------------------------
    //
    // Same gesture as a pasted pay code: one thing on the line, and Flizy
    // answers with what it is before asking for anything.
    //
    // The trust properties are NOT the same, and the copy has to carry that.
    // A pay code resolves to a name Flizy issued, so nobody else can put a
    // name behind it. A token ticker is whatever its deployer typed, and
    // market cap is trivially inflated by whoever made the token. So the
    // facts come first, the permission line second, and neither carries an
    // adjective: editorialising here either scares people off tokens that are
    // fine or cries wolf on ones that are not, and both teach people to skim.

    // Answering "how much ETH?".
    if (pendingTokenBuys.has(ctx.key)) {
      const retarget = parseBareContract(text);
      if (!retarget) {
        const spend = parseBareAmount(text);
        if (spend) {
          const buy = pendingTokenBuys.get(ctx.key);
          if (spend.asset !== 'ETH') {
            await reply(ctx, `This step spends ETH. How much ETH for ${buy.symbol}?`);
            return;
          }
          pendingTokenBuys.delete(ctx.key);
          // Straight into the swap path that already exists. resolveToken
          // takes a raw address, so an unlisted token needs no second engine
          // -- it is the same quote, the same fee, the same confirm.
          await handleSwapCommand(ctx, user, account, {
            kind: 'buy',
            amountMode: 'in',
            amount: spend.amountEth,
            tokenIn: 'ETH',
            tokenOut: buy.address,
          });
          return;
        }
        pendingTokenBuys.delete(ctx.key);
      }
    }

    const pastedContract = parseBareContract(text);
    if (pastedContract) {
      const siteAcc = await requireLinkedSite(ctx, account);
      if (!siteAcc) return;

      // A pasted wallet address must never open a buy flow. Code at the
      // address is the only reliable way to tell a token from a person.
      let code;
      try {
        code = await provider.getCode(pastedContract.address);
      } catch (err) {
        console.error('paste buy getCode:', publicErrorMessage(err));
        await reply(ctx, 'Could not reach the chain. Try again shortly.');
        return;
      }
      if (!code || code === '0x') {
        pendingTokenBuys.delete(ctx.key);
        await reply(
          ctx,
          [
            'That is a wallet address, not a token contract.',
            'To pay it: send 0.01 to 0x...',
          ].join('\n')
        );
        return;
      }

      let overview;
      try {
        overview = await getTokenOverview(provider, pastedContract.address, chain.id);
      } catch (err) {
        console.error('paste buy overview:', publicErrorMessage(err));
        pendingTokenBuys.delete(ctx.key);
        await reply(ctx, 'That contract does not answer as a token.');
        return;
      }

      if (!overview.pool) {
        pendingTokenBuys.delete(ctx.key);
        await reply(
          ctx,
          [
            `${overview.symbol}`,
            'No pool for this token on GIWA Sepolia.',
            'There is nothing to buy it from yet.',
          ].join('\n')
        );
        return;
      }

      pendingTokenBuys.set(ctx.key, {
        address: overview.address,
        symbol: overview.symbol,
        createdAt: Date.now(),
      });

      const liq = formatEth(ethers.formatEther(overview.liquidityEthWei));
      const mc = overview.marketCapEth == null ? null : formatEth(overview.marketCapEth);
      await reply(
        ctx,
        [
          mc ? `${overview.symbol}  MC ${mc} ETH` : `${overview.symbol}`,
          `Liquidity ${liq} ETH`,
          overview.isListed ? null : 'Flizy has not reviewed this token. You can still buy it.',
          '',
          `How much ETH do you want to spend on ${overview.symbol}?`,
          'Or: cancel',
        ]
          .filter((line) => line !== null)
          .join('\n')
      );
      return;
    }
    // --- Paste-first pay ------------------------------------------------
    //
    // Two messages: the code, then the amount. The bank gesture -- you type the
    // account number, you are told whose it is, then you say how much. It is
    // the only way to send that needs no verb, which is the point: the measured
    // problem is not policy, it is that people have to know what to type.
    //
    // The name shown here is read live and is the same label the confirm screen
    // will carry, so approving the name and approving the send cannot disagree.

    // Answering "how much into this pot?".
    if (pendingPotPays.has(ctx.key)) {
      const amount = parseBareAmount(text);
      if (amount) {
        const ask = pendingPotPays.get(ctx.key);
        pendingPotPays.delete(ctx.key);
        await handlePayPot(ctx, user, account, {
          code: ask.code,
          amountEth: amount.amountEth,
        });
        return;
      }
      // Anything else closes the question rather than leaving it hanging, and
      // falls through to be read as a command in its own right.
      pendingPotPays.delete(ctx.key);
    }

    // Answering the "how much?" we already asked.
    if (pendingPayCodes.has(ctx.key)) {
      // A second code means the payer is correcting who they are paying, not
      // naming an absurd amount. Checked first for that reason: nobody sends
      // 622412799 ETH, and reading it as an amount would be a confusing refusal.
      const retarget = parseBarePayCode(text);
      if (!retarget) {
        const amount = parseBareAmount(text);
        if (amount) {
          const paste = pendingPayCodes.get(ctx.key);
          pendingPayCodes.delete(ctx.key);
          await handleSend(
            ctx,
            user,
            account,
            amount.amountEth,
            paste.code,
            false,
            false,
            amount.asset
          );
          return;
        }
        pendingPayCodes.delete(ctx.key);
        // Fall through: whatever they typed is a command in its own right, or
        // nothing. Either way the question is closed rather than left hanging.
      }
    }

    const pastedCode = parseBarePayCode(text);
    if (pastedCode) {
      const siteAcc = await requireLinkedSite(ctx, account);
      if (!siteAcc) return;

      let dest;
      try {
        dest = await resolveFlizyPayDestination(supabase, pastedCode.code, siteAcc.id);
      } catch (err) {
        console.error('paste pay lookup:', publicErrorMessage(err));
        await reply(ctx, 'Could not look up that pay code. Try again shortly.');
        return;
      }

      if (!dest.found) {
        pendingPayCodes.delete(ctx.key);
        await reply(
          ctx,
          [
            'No Flizy account has that pay code.',
            'Check the digits under their QR and send it again.',
          ].join('\n')
        );
        return;
      }
      if (dest.self) {
        pendingPayCodes.delete(ctx.key);
        await reply(ctx, 'That is your own pay code.');
        return;
      }
      if (dest.noWallet || !dest.address) {
        pendingPayCodes.delete(ctx.key);
        await reply(ctx, 'That account has no wallet yet, so it cannot be paid.');
        return;
      }

      pendingPayCodes.set(ctx.key, {
        code: pastedCode.code,
        address: dest.address,
        label: dest.label,
        createdAt: Date.now(),
      });
      await reply(
        ctx,
        [
          `That is ${dest.label}.`,
          '',
          'How much? Reply with the amount, e.g. 0.01',
          'Or: cancel',
        ].join('\n')
      );
      return;
    }

    if (pendingPayAsks.has(ctx.key)) {
      const ask = pendingPayAsks.get(ctx.key);
      const token = String(text || '')
        .trim()
        .replace(/^@+/, '');
      if (isPayCodeFormat(token) || /^[a-z][a-z0-9]{2,23}$/i.test(token)) {
        pendingPayAsks.delete(ctx.key);
        await handleSend(
          ctx,
          user,
          account,
          ask.amountEth,
          token,
          false,
          false,
          'ETH',
          null,
          false,
          ask.note
        );
        return;
      }
      if (
        !parseSendCommand(text) &&
        !parseSwapCommand(text) &&
        !parsePayAskCommand(text) &&
        !parseMintCommand(text)
      ) {
        await reply(
          ctx,
          'Send their @username or the 9-digit pay code under the QR.\nOr: cancel'
        );
        return;
      }
      pendingPayAsks.delete(ctx.key);
    }

    const payAsk = parsePayAskCommand(text);
    if (payAsk) {
      const siteAcc = await requireLinkedSite(ctx, account);
      if (!siteAcc) return;
      pendingPayAsks.set(ctx.key, {
        amountEth: payAsk.amountEth,
        note: payAsk.note,
        createdAt: Date.now(),
      });
      await reply(
        ctx,
        [
          `Pay ${payAsk.amountEth} ETH for ${payAsk.note}.`,
          'Who? Send their @username or the code under their QR.',
          'Or: cancel',
        ].join('\n')
      );
      return;
    }

    // Ahead of every send shape: an amount in a currency we cannot price is
    // answered in words. Before this it was silence on WhatsApp, and
    // `send N5000 to bob` was read as a token called n5000.
    const unpriced = unsupportedCurrencyCommand(text);
    if (unpriced) {
      await reply(
        ctx,
        [
          `${unpriced} amounts are not supported yet.`,
          '',
          'Send an amount in ETH or a listed token:',
          `  ${cmd(ctx, 'send 0.01 to name')}`,
          `  ${cmd(ctx, 'send 10 flz to name')}`,
        ].join('\n')
      );
      return;
    }

    const mintCmd = parseMintCommand(text);
    if (mintCmd) {
      await handleMint(ctx, user, account, mintCmd);
      return;
    }

    const nftSend = parseNftSendCommand(text);
    // Several ids is a batch, and the named-asset path below is what walks one.
    // Only the single-id form keeps this direct route.
    if (nftSend && (nftSend.nftTokenIds || []).length === 1) {
      // A freshly typed send starts over. Without this an abandoned batch would
      // wake up on the next NFT that landed and ask about ids nobody is sending.
      pendingMultiNftSends.delete(ctx.key);
      await handleSend(
        ctx,
        user,
        account,
        nftSend.amountEth,
        nftSend.toRaw,
        nftSend.isAddress,
        nftSend.isPhone,
        nftSend.asset,
        nftSend.platform || null,
        Boolean(nftSend.isEmail),
        null,
        { ticker: nftSend.nftTicker, tokenId: nftSend.nftTokenId }
      );
      return;
    }

    const namedSend = parseSendNamedAssetCommand(text);
    if (namedSend) {
      await handleNamedAssetSend(ctx, user, account, namedSend);
      return;
    }

    const send = parseSendCommand(text);
    if (send) {
      pendingMultiNftSends.delete(ctx.key);
      await handleSend(
        ctx,
        user,
        account,
        send.amountEth,
        send.toRaw,
        send.isAddress,
        send.isPhone,
        send.asset || 'ETH',
        send.platform || null,
        Boolean(send.isEmail),
        null,
        null,
        send.assetExplicit !== false
      );
      return;
    }

    if (isTelegram(ctx)) {
      await reply(ctx, `Unknown command. Send ${cmd(ctx, 'help')} for the list.`);
    }
  } catch (err) {
    console.error('router error:', publicErrorMessage(err));
    await reply(ctx, 'Something went wrong. Please try again.');
  }
}

module.exports = {
  handle,
  handleSharedPhone,
  pendingFlowFor,
  discardPendingFlows,
  pruneExpiredPending,
  isFlizyCommand,
  isFlizyCommandBody,
  isDeclineCommand,
  parseDeclineCommand,
  parseRemindCommand,
  isConfirmCommand,
  isCancelCommand,
  normalizeInput,
  commandMenu,
  helpText,
  welcomeState,
  welcomeText,
  // exported for tests
  isMerchantSaveReply,
  parseSendCommand,
  parseNftSendCommand,
  parseSendNamedAssetCommand,
  parseMintCommand,
  parsePayAskCommand,
  parseSwapCommand,
  parseLinkCommand,
  parseRequestCommand,
  parseCollectCommand,
  parsePotsListCommand,
  parsePotCommand,
  parsePayPotCommand,
  parsePayPotNoAmountCommand,
  parseClosePotCommand,
  parseRenamePotCommand,
  parseSplitCommand,
  parseRequestsCommand,
  resolveClaimIdentity,
  resolveSendTarget,
  requesterLabel,
  transferKey,
  cmd,
};
