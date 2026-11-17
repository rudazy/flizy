/**
 * Claim handlers: hold, notify, list, cancel, payout.
 *
 * A claim is money reserved for someone until they prove who they are.
 * Opening a hold, telling them it is waiting, listing it, cancelling it and
 * paying it out all live here. The data layer is lib/claims.js; this file is
 * the chat commands and the send-path helpers that create a hold.
 *
 * handleSend and handleConfirm stay in the router. They dispatch into this
 * module. handleClaimMenuReply also stays: it answers numbered picks for
 * both claims and payment requests, and pulling it would pull the request
 * runners with it or import the router back.
 *
 * Dependencies go one way. This imports runtime, the chat layer, account
 * resolution and the claims data layer; nothing here imports router.
 */

const { ethers } = require('ethers');
const { config } = require('../config');
const { chain, provider, escrowWallet, supabase } = require('../runtime');
const { planGasBufferEth } = require('../gatorExecute');
const { refusePlanSpend } = require('../reserves');
const { attachSendFee } = require('../engine/sendFee');
const { publicErrorMessage } = require('../sanitize');
const {
  reply,
  cmd,
  withFundHint,
  confirmButtons,
  channelName,
  isTelegram,
} = require('../commands/chat');
const {
  actorSessionFlags,
  requireLinkedSite,
  resolveLinkedSiteAccount,
  resolveClaimIdentity,
  senderLabel,
} = require('../commands/account');
const { pendingSends, pendingClaimMenus } = require('../commands/pending');
const { tierApprovalNote, txPin } = require('../tiers');
const {
  createSendIntent,
  evaluateClaimHoldPolicy,
  buildClaimPlan,
  formatClaimPlanPreview,
  assertPlanFunded,
  executeClaimRefund,
  executeClaimPayout,
} = require('../engine');
const {
  normalizeWaHint,
  listOutgoingPending,
  listIncomingPending,
  formatClaimsMenu,
  formatClaimClaimedNotice,
  claimViaLine,
  claimRecipientLabel,
  formatClaimAmount,
  getClaimByToken,
  attachSenderLabels,
  outgoingClaimDetail,
} = require('../claims');
const { loadClaimEvents, recordClaimEvent } = require('../claimEvents');
const {
  platformRecipient,
  emailRecipient,
  telegramPendingUsernameRecipient,
  isTelegramPendingUsernameId,
  telegramPendingUsernameFromId,
} = require('../claimRecipient');
const {
  findAccountIdByEmail,
  listClaimableEmailsForAccount,
} = require('../accountEmails');
const {
  CHANNELS,
  getAccountByIdentity,
  listIdentitiesForAccount,
} = require('../identity');
const { isPlausiblePhone } = require('../phone');
const { resolveGitHubUser, normalizeGitHubLogin } = require('../githubLookup');
const {
  resolveDiscordUser,
  discordNotFoundMessage,
  discordAmbiguousMessage,
  discordInvalidMessage,
} = require('../discordLookup');
const { resolveXUser, normalizeXHandle } = require('../xLookup');
const {
  resolveTelegramUser,
  normalizeTelegramUsername,
  telegramInvalidMessage,
  telegramAmbiguousMessage,
} = require('../telegramLookup');
const { ensureAgentWallet } = require('../agentWallet');
const { resolveListedSendAsset, SOCIAL_SEND_REFUSAL } = require('../dex');
const fees = require('../fees');
const { feeDecimals, priceMicroFor } = require('../feeQuote');

/** The most a claim held for a private Telegram @username may carry, in USD. */
const TGUSER_DEFAULT_MAX_USD = '20';
const {
  resolveListedNft,
  normalizeNftTokenId,
  nftOwnedBy,
} = require('../listedNfts');
const { notifyPhone, notifyAccount } = require('../notify');
const { listIncomingRequests } = require('../paymentRequests');

async function loadAgentFunds(siteAcc, tokenAddress) {
  const acc = await ensureAgentWallet(siteAcc.id);
  const fromAddress = ethers.getAddress(acc.agent_wallet_address);
  const fromBalanceEth = ethers.formatEther(await provider.getBalance(fromAddress));
  let tokenBalance = null;
  let tokenDecimals = null;
  if (tokenAddress) {
    const erc20 = new ethers.Contract(
      tokenAddress,
      [
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)',
      ],
      provider
    );
    const [bal, dec] = await Promise.all([erc20.balanceOf(fromAddress), erc20.decimals()]);
    tokenDecimals = Number(dec);
    tokenBalance = ethers.formatUnits(bal, tokenDecimals);
  }
  return { accountId: siteAcc.id, fromAddress, fromBalanceEth, tokenBalance, tokenDecimals };
}

async function resolveClaimListedAsset(ctx, sendAsset) {
  try {
    return resolveListedSendAsset(sendAsset, chain.id);
  } catch (err) {
    await reply(ctx, err.message || SOCIAL_SEND_REFUSAL);
    return null;
  }
}

/**
 * Listed token or listed NFT collection for a claim hold.
 * @param {{ ticker: string, tokenId: string }|null} [nft]
 */
async function resolveClaimHoldAsset(ctx, sendAsset, nft) {
  if (nft && nft.ticker && nft.tokenId) {
    try {
      const col = resolveListedNft(nft.ticker, chain.id);
      const tokenId = normalizeNftTokenId(nft.tokenId);
      if (tokenId == null) {
        await reply(ctx, 'Invalid token id.');
        return null;
      }
      return {
        symbol: col.ticker.toUpperCase(),
        tokenAddress: col.address,
        nftTokenId: tokenId,
      };
    } catch (err) {
      await reply(ctx, err.message || 'Unknown collection.');
      return null;
    }
  }
  const listed = await resolveClaimListedAsset(ctx, sendAsset);
  if (!listed) return null;
  return { ...listed, nftTokenId: null };
}

/**
 * Shared claim-hold plan + confirm prompt (phone, email, platform).
 */
async function openClaimHold(ctx, user, siteAcc, amountEth, listed, extra) {
  const actor = await actorSessionFlags(ctx, user, siteAcc);
  const intent = createSendIntent({
    actor,
    amountEth,
    toAddress: null,
    toLabel: extra.toLabel,
    toRaw: extra.toRaw,
    toIsAddress: false,
    chainId: String(chain.chainId),
    asset: listed.symbol,
  });

  const policy = await evaluateClaimHoldPolicy(intent, { accountRow: siteAcc });
  if (policy.decision === 'DENY') {
    await reply(ctx, policy.message || 'Not allowed.');
    return;
  }

  let funds;
  try {
    funds = await loadAgentFunds(siteAcc, listed.nftTokenId ? null : listed.tokenAddress);
  } catch (err) {
    console.error('agent balance check failed:', publicErrorMessage(err));
    await reply(ctx, 'Could not check your Flizy wallet. Try again shortly.');
    return;
  }

  let nftOwned;
  if (listed.nftTokenId && listed.tokenAddress) {
    try {
      nftOwned = await nftOwnedBy(
        provider,
        listed.tokenAddress,
        listed.nftTokenId,
        funds.fromAddress
      );
    } catch (err) {
      console.error('nft owner check failed:', publicErrorMessage(err));
      await reply(ctx, 'Could not check that NFT. Try again shortly.');
      return;
    }
  }

  const plan = buildClaimPlan({
    intent,
    policy,
    chain: {
      chainId: chain.chainId,
      chainName: chain.name,
      nativeSymbol: chain.nativeSymbol || 'ETH',
    },
    fromAddress: funds.fromAddress,
    toWaHint: extra.toWaHint || null,
    recipient: extra.recipient || null,
    fromBalanceEth: funds.fromBalanceEth,
    tokenAddress: listed.tokenAddress,
    tokenSymbol: listed.symbol,
    tokenBalance: funds.tokenBalance,
    nftTokenId: listed.nftTokenId || extra.nftTokenId || null,
  });

  // A gator's buffer is EntryPoint's prefund, not the flat EOA figure.
  const planGasBuffer = await planGasBufferEth(provider, funds.accountId, funds.fromAddress);
  // The Flizy fee, when fees are on (lib/engine/sendFee.js): quoted now, shown
  // in the preview, and counted by every check below.
  const feed = await attachSendFee({
    plan,
    supabase,
    provider,
    chainKey: chain.id,
    accountId: funds.accountId,
    ethBalanceWei: ethers.parseEther(String(funds.fromBalanceEth)),
    tokenBalanceUnits: funds.tokenBalance == null || funds.tokenDecimals == null ? null : ethers.parseUnits(String(funds.tokenBalance), funds.tokenDecimals),
    gasBufferWei: ethers.parseEther(String(planGasBuffer)),
  });
  if (!feed.ok) {
    await reply(ctx, feed.message);
    return;
  }
  const reserved = await refusePlanSpend(supabase, funds.accountId, plan, {
    ethBalanceHuman: funds.fromBalanceEth,
    tokenBalanceHuman: funds.tokenBalance,
    tokenDecimals: funds.tokenDecimals,
    gasBufferEth: planGasBuffer,
  });
  if (!reserved.ok) {
    await reply(ctx, reserved.message);
    return;
  }
  const funded = assertPlanFunded(plan, funds.fromBalanceEth, planGasBuffer, {
    tokenBalance: funds.tokenBalance,
    nftOwned,
  });
  if (!funded.ok) {
    await reply(ctx, withFundHint(ctx, funded, funded.message));
    return;
  }

  // Money held for someone who is not on Flizy yet takes the PIN whenever the
  // transaction PIN is on (lib/tiers.js): there is no recipient the account has
  // paid before. With it off, it is a plain CONFIRM like every other plan.
  pendingSends.set(ctx.key, { plan, createdAt: Date.now(), needsApproval: txPin.required });
  const preview = formatClaimPlanPreview(plan);
  await reply(ctx, txPin.required ? `${preview}\n\n${tierApprovalNote('claim_hold')}` : preview, {
    buttons: confirmButtons(),
  });
}

/**
 * How the recipient unlocks a platform claim (channel-specific).
 * @param {string|null|undefined} channel
 */
function platformClaimLinkHowTo(channel) {
  const ch = String(channel || '').toLowerCase();
  if (ch === 'github') {
    return 'They receive after they link GitHub on Flizy (Account → Platforms → Link GitHub), then {{cmd:claim}} or claim on the site.';
  }
  if (ch === 'discord') {
    return 'They receive after they link Discord on Flizy (Account → Platforms → Link Discord), then {{cmd:claim}} or claim on the site.';
  }
  if (ch === 'x') {
    return 'They receive after they link X on Flizy (Account → Platforms → Link X), then {{cmd:claim}} or claim on the site.';
  }
  if (ch === 'telegram') {
    return 'They receive after they open the Flizy Telegram bot, link with a site code (link CODE) using the same Telegram account, then {{cmd:claim}} or claim on the site. Their @username is saved on link so this hold matches. After that, the Telegram account stays tied to their Flizy account until they unlink.';
  }
  return 'They receive after they link that platform on Flizy (Account → Platforms), then {{cmd:claim}} or claim on the site.';
}

function emailClaimLinkHowTo() {
  return 'They receive after they create a Flizy account with that email, verify it with the code we email them (or add and verify a secondary email), then claim on the site or in chat.';
}

/**
 * Hold listed asset for an email address (registration email or verified secondary).
 */
async function handleSendEmailClaim(
  ctx,
  user,
  siteAcc,
  amountEth,
  emailRaw,
  sendAsset = 'ETH',
  listedOverride = null
) {
  let recipient;
  try {
    recipient = emailRecipient(emailRaw);
  } catch (err) {
    await reply(
      ctx,
      [
        err.message || 'Invalid email address.',
        `Example: ${cmd(ctx, 'send 0.001 to friend@email.com')}`,
      ].join('\n')
    );
    return;
  }

  try {
    const own = await listClaimableEmailsForAccount(siteAcc.id);
    if (own.includes(recipient.email)) {
      await reply(ctx, 'That email is on your own Flizy account.');
      return;
    }
  } catch (err) {
    console.warn('email self-send check:', publicErrorMessage(err));
  }

  const listed = listedOverride || (await resolveClaimListedAsset(ctx, sendAsset));
  if (!listed) return;
  await openClaimHold(ctx, user, siteAcc, amountEth, listed, {
    toLabel: claimRecipientLabel(recipient),
    toRaw: recipient.email,
    recipient,
  });
}

/**
 * A claim held for a private Telegram @username can be collected by whoever
 * holds that name when they claim, so it is capped: at most
 * CLAIM_TGUSER_MAX_USD (default $20) of a token that can be priced. An NFT, or
 * an amount that cannot be priced, is refused rather than let through.
 * @returns {Promise<string|null>} the refusal, or null when it may go ahead
 */
async function tguserCapRefusal(amountEth, sendAsset, listedOverride = null) {
  const tooMuch = (cap) =>
    `A private Telegram user can be sent at most ${cap} at a time: whoever holds the @username when they claim gets it. Send a smaller amount, or send to their phone or email.`;
  let capMicro;
  try {
    capMicro = fees.parseUsdMicro(process.env.CLAIM_TGUSER_MAX_USD || TGUSER_DEFAULT_MAX_USD, 'CLAIM_TGUSER_MAX_USD');
  } catch (err) {
    console.error('tguser cap:', publicErrorMessage(err));
    return 'Sending to a private Telegram user is unavailable right now. Send to their phone or email instead.';
  }
  const capText = fees.centsText(capMicro);
  let listed = listedOverride;
  if (!listed) {
    try {
      listed = resolveListedSendAsset(sendAsset, chain.id);
    } catch {
      return null; // the usual refusal follows from resolveClaimListedAsset
    }
  }
  if (listed.nftTokenId) return tooMuch(capText);
  try {
    const symbol = String(listed.symbol || 'ETH').toUpperCase();
    const decimals = feeDecimals(symbol);
    const { priceMicro } = await priceMicroFor(symbol, { provider, cfg: fees.feeConfig(), chainKey: chain.id });
    const usdMicro = fees.unitsToUsdMicro(ethers.parseUnits(String(amountEth), decimals), priceMicro, decimals);
    return usdMicro > capMicro ? tooMuch(capText) : null;
  } catch (err) {
    console.warn('tguser cap price:', publicErrorMessage(err));
    return tooMuch(capText);
  }
}

/**
 * Hold listed asset for a platform identity (GitHub / Discord / X / Telegram).
 * Handle is resolved to immutable id at plan time; money routes on the id only.
 */
async function handleSendPlatformClaim(
  ctx,
  user,
  siteAcc,
  amountEth,
  handleRaw,
  platform,
  sendAsset = 'ETH',
  listedOverride = null
) {
  const ch =
    platform === 'github'
      ? CHANNELS.GITHUB
      : platform === 'discord'
        ? CHANNELS.DISCORD
        : platform === 'x'
          ? CHANNELS.X
          : platform === 'telegram'
            ? CHANNELS.TELEGRAM
            : null;
  if (!ch) {
    await reply(ctx, 'Unsupported platform.');
    return;
  }

  const where =
    ch === CHANNELS.GITHUB
      ? 'GitHub'
      : ch === CHANNELS.DISCORD
        ? 'Discord'
        : ch === CHANNELS.TELEGRAM
          ? 'Telegram'
          : 'X';

  let profile;
  try {
    if (ch === CHANNELS.GITHUB) {
      const login = normalizeGitHubLogin(handleRaw);
      if (!login) {
        await reply(
          ctx,
          [
            'Invalid GitHub username.',
            `Example: ${cmd(ctx, 'send 0.001 to @rudazy on github')}`,
          ].join('\n')
        );
        return;
      }
      profile = await resolveGitHubUser(login);
      if (!profile) {
        await reply(ctx, `No GitHub user named ${login}. Check the spelling.`);
        return;
      }
    } else if (ch === CHANNELS.DISCORD) {
      try {
        profile = await resolveDiscordUser(handleRaw);
      } catch (err) {
        if (err && err.code === 'DISCORD_INVALID') {
          await reply(ctx, discordInvalidMessage((body) => cmd(ctx, body)));
          return;
        }
        if (err && err.code === 'DISCORD_AMBIGUOUS') {
          await reply(ctx, discordAmbiguousMessage((body) => cmd(ctx, body)));
          return;
        }
        if (err && err.code === 'DISCORD_LOOKUP_FAILED') {
          await reply(ctx, err.message);
          return;
        }
        throw err;
      }
      if (!profile) {
        await reply(ctx, discordNotFoundMessage((body) => cmd(ctx, body)));
        return;
      }
    } else if (ch === CHANNELS.TELEGRAM) {
      try {
        profile = await resolveTelegramUser(handleRaw);
      } catch (err) {
        if (
          err &&
          (err.code === 'TELEGRAM_INVALID' ||
            err.code === 'TELEGRAM_AMBIGUOUS' ||
            err.code === 'TELEGRAM_LOOKUP_UNAVAILABLE' ||
            err.code === 'TELEGRAM_RATE_LIMIT' ||
            err.code === 'TELEGRAM_LOOKUP_FAILED')
        ) {
          await reply(
            ctx,
            err.code === 'TELEGRAM_INVALID'
              ? telegramInvalidMessage((body) => cmd(ctx, body))
              : err.code === 'TELEGRAM_AMBIGUOUS'
                ? telegramAmbiguousMessage((body) => cmd(ctx, body))
                : err.message
          );
          return;
        }
        throw err;
      }
      // Bot API cannot resolve private @usernames. Hold by handle until they
      // join Flizy and link that Telegram account (display_handle match).
      if (!profile) {
        const pendingHandle = normalizeTelegramUsername(handleRaw);
        if (!pendingHandle) {
          await reply(ctx, telegramInvalidMessage((body) => cmd(ctx, body)));
          return;
        }
        profile = {
          id: null,
          login: pendingHandle,
          pendingUsername: true,
        };
      } else if (profile.login) {
        const n = normalizeTelegramUsername(profile.login);
        if (n) profile = { ...profile, login: n };
      }
    } else {
      const login = normalizeXHandle(handleRaw);
      if (!login) {
        await reply(
          ctx,
          [
            'Invalid X username.',
            `Example: ${cmd(ctx, 'send 0.001 to @jack on x')}`,
          ].join('\n')
        );
        return;
      }
      profile = await resolveXUser(login);
      if (!profile) {
        await reply(ctx, `No X user named ${login}. Check the spelling.`);
        return;
      }
    }
  } catch (err) {
    if (err && err.code) {
      await reply(ctx, err.message || 'Lookup failed.');
      return;
    }
    console.warn('platform resolve:', publicErrorMessage(err));
    await reply(ctx, `Could not look up that ${where} user. Try again shortly.`);
    return;
  }

  let recipient;
  try {
    if (profile.pendingUsername || (ch === CHANNELS.TELEGRAM && !profile.id)) {
      // Held by a handle, not an id: kept small (CLAIM_TGUSER_MAX_USD).
      const refused = await tguserCapRefusal(amountEth, sendAsset, listedOverride);
      if (refused) {
        await reply(ctx, refused);
        return;
      }
      recipient = telegramPendingUsernameRecipient(profile.login || handleRaw);
    } else {
      recipient = platformRecipient(ch, profile.id, profile.login);
    }
  } catch (err) {
    await reply(ctx, err.message || `Could not address that ${where} user.`);
    return;
  }

  try {
    if (profile.id && !profile.pendingUsername) {
      const bound = await getAccountByIdentity(ch, profile.id);
      if (bound?.account?.id && bound.account.id === siteAcc.id) {
        await reply(ctx, `That ${where} account is linked to your own Flizy account.`);
        return;
      }
    } else if (ch === CHANNELS.TELEGRAM && recipient.displayHandle) {
      // Pending-by-handle: refuse if this account already holds that @username.
      const mine = await listIdentitiesForAccount(siteAcc.id);
      const want = String(recipient.displayHandle).toLowerCase();
      const selfHandle = (mine || []).some(
        (row) =>
          row.channel === CHANNELS.TELEGRAM &&
          String(row.display_handle || '')
            .replace(/^@+/, '')
            .toLowerCase() === want
      );
      if (selfHandle) {
        await reply(ctx, 'That Telegram username is linked to your own Flizy account.');
        return;
      }
    }
  } catch (err) {
    console.warn('platform self-send check:', publicErrorMessage(err));
  }

  const listed = listedOverride || (await resolveClaimListedAsset(ctx, sendAsset));
  if (!listed) return;
  await openClaimHold(ctx, user, siteAcc, amountEth, listed, {
    toLabel: claimRecipientLabel(recipient),
    toRaw: `${ch}:${profile.login || profile.id}`,
    recipient,
  });
}

/**
 * A claim addressed to a number that is already a Flizy user: tell them on every
 * channel they have linked. Unknown numbers are never cold-messaged; the sender
 * shares the claim link instead.
 *
 * The copy uses the "flizy" prefix rather than this sender's channel style,
 * because the recipient may well be reading it somewhere else. That prefix is
 * accepted on every channel.
 *
 * @returns {Promise<boolean>} true when the notice actually went somewhere
 */
async function notifyClaimTarget(ctx, toWaHint, amountEth, fromAccountId, asset, nftTokenId) {
  try {
    const from = await senderLabel(fromAccountId);
    const amountLine = formatClaimAmount({
      amount_eth: amountEth,
      asset,
      nft_token_id: nftTokenId,
    });
    const res = await notifyPhone(
      toWaHint,
      [
        'Pending claim on Flizy',
        '',
        `Amount: ${amountLine}`,
        `From:   ${from}`,
        '',
        'Receive it: {{cmd:claim}}',
        'It stays held until you do. The sender can cancel until then.',
      ].join('\n'),
      { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
    );
    return Boolean(res.known) && res.delivered + res.queued > 0;
  } catch (err) {
    console.warn('notifyClaimTarget:', publicErrorMessage(err));
    return false;
  }
}

/**
 * Claim addressed to a platform identity already linked on Flizy.
 * @returns {Promise<boolean>}
 */
async function notifyClaimPlatformTarget(
  ctx,
  channel,
  externalId,
  amountEth,
  fromAccountId,
  asset,
  nftTokenId
) {
  try {
    const bound = await getAccountByIdentity(channel, externalId);
    if (!bound?.account?.id) return false;
    const from = await senderLabel(fromAccountId);
    const amountLine = formatClaimAmount({
      amount_eth: amountEth,
      asset,
      nft_token_id: nftTokenId,
    });
    const res = await notifyAccount(
      bound.account.id,
      [
        'Pending claim on Flizy',
        '',
        `Amount: ${amountLine}`,
        `From:   ${from}`,
        '',
        'Receive it: {{cmd:claim}}',
        'It stays held until you do. The sender can cancel until then.',
      ].join('\n'),
      { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
    );
    return res.delivered + res.queued > 0;
  } catch (err) {
    console.warn('notifyClaimPlatformTarget:', publicErrorMessage(err));
    return false;
  }
}

/**
 * Claim addressed to an email already on Flizy (registration or verified secondary).
 * @returns {Promise<boolean>}
 */
async function notifyClaimEmailTarget(ctx, email, amountEth, fromAccountId, asset, nftTokenId) {
  try {
    const accountId = await findAccountIdByEmail(email);
    if (!accountId) return false;
    const from = await senderLabel(fromAccountId);
    const amountLine = formatClaimAmount({
      amount_eth: amountEth,
      asset,
      nft_token_id: nftTokenId,
    });
    const res = await notifyAccount(
      accountId,
      [
        'Pending claim on Flizy',
        '',
        `Amount: ${amountLine}`,
        `From:   ${from}`,
        '',
        'Receive it: {{cmd:claim}} (chat) or Claim on the site',
        'It stays held until you do. The sender can cancel until then.',
      ].join('\n'),
      { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
    );
    return res.delivered + res.queued > 0;
  } catch (err) {
    console.warn('notifyClaimEmailTarget:', publicErrorMessage(err));
    return false;
  }
}

async function handleCancelClaims(ctx, user, account, filter) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  const phoneFilter =
    filter && filter !== 'all' && isPlausiblePhone(filter) ? normalizeWaHint(filter) : null;

  let claims;
  try {
    claims = await listOutgoingPending(siteAcc.id, phoneFilter || undefined);
  } catch (err) {
    console.error('listOutgoingPending:', publicErrorMessage(err));
    await reply(ctx, 'Could not load claims. Try again.');
    return;
  }
  // What has happened to each. Without them the list still shows, as waiting.
  try {
    const events = await loadClaimEvents(supabase, claims.map((c) => c.id));
    for (const c of claims) c.events = events.get(String(c.id)) || [];
  } catch (err) {
    console.warn('claim events:', publicErrorMessage(err));
  }

  if (!claims.length) {
    await reply(
      ctx,
      phoneFilter
        ? `No pending claims to +${phoneFilter}.`
        : `No pending claims.\nSend to a phone: ${cmd(ctx, 'send 0.01 ETH to +234 708 043 7343')}`
    );
    return;
  }

  if (claims.length === 1) {
    pendingClaimMenus.set(ctx.key, {
      mode: 'cancel',
      claims,
      createdAt: Date.now(),
      awaitConfirmId: claims[0].id,
    });
    await reply(
      ctx,
      [
        'Cancel this claim?',
        `${claimRecipientLabel(claims[0])}  ${formatClaimAmount(claims[0])}`,
        ...outgoingClaimDetail(claims[0]),
        '',
        'Reply: confirm   cancel it, the money comes back to you',
        'Or: cancel   keep it held for them',
      ].join('\n'),
      { buttons: confirmButtons() }
    );
    return;
  }

  pendingClaimMenus.set(ctx.key, { mode: 'cancel', claims, createdAt: Date.now() });
  await reply(ctx, formatClaimsMenu(claims, 'outgoing'));
}

/**
 * A claim opened from its Telegram start link: who sent what, and whether this
 * Telegram account can receive it. Never says who it was sent to.
 *
 * A claim held for a private @username is pinned, once, to the numeric id of
 * the first person who opens it here while holding that @username; from then
 * on only that id can claim it. Anyone else is refused.
 */
async function handleClaimStart(ctx, account, token) {
  let claim;
  try {
    claim = await getClaimByToken(token);
  } catch (err) {
    console.error('claim start:', publicErrorMessage(err));
    await reply(ctx, 'Could not open that payment. Try again shortly.');
    return;
  }
  if (!claim) {
    await reply(ctx, 'That claim link is not valid.');
    return;
  }
  if (claim.status !== 'pending') {
    await reply(ctx, 'This payment is no longer waiting to be claimed.');
    return;
  }
  const page = `${config.siteUrl}/claim/${token}`;
  const siteAcc = await resolveLinkedSiteAccount(ctx, account).catch(() => null);
  if (siteAcc?.id && siteAcc.id === claim.from_account_id) {
    await reply(ctx, `This is a payment you sent. See what happened to it: ${cmd(ctx, 'claims')}`);
    return;
  }
  await recordClaimEvent(supabase, claim.id, 'link_opened');

  const head = `${await senderLabel(claim.from_account_id)} sent you ${formatClaimAmount(claim)} on Flizy (testnet).`;
  if (claim.to_channel !== 'telegram' || ctx.channel !== 'telegram') {
    await reply(ctx, [head, '', `See how to receive it: ${page}`].join('\n'));
    return;
  }

  const me = String(ctx.externalId || '');
  const refuse = () => reply(ctx, [head, '', 'This payment cannot be received with this Telegram account.'].join('\n'));
  if (!/^\d+$/.test(me)) return refuse();
  if (isTelegramPendingUsernameId(claim.to_external_id)) {
    const handle = String(ctx.displayHandle || '').replace(/^@+/, '').toLowerCase();
    if (!handle || handle !== telegramPendingUsernameFromId(claim.to_external_id)) return refuse();
    // Held by a handle until now: tie it to this account's id, once.
    const { data: pinned, error } = await supabase
      .from('claims')
      .update({ to_external_id: me })
      .eq('id', claim.id)
      .eq('status', 'pending')
      .eq('to_external_id', claim.to_external_id)
      .select('id')
      .maybeSingle();
    if (error || !pinned) {
      if (error) console.error('claim pin:', publicErrorMessage(error));
      await reply(ctx, 'Could not open that payment. Try again shortly.');
      return;
    }
    await recordClaimEvent(supabase, claim.id, 'recipient_pinned', { channel: 'telegram' });
  } else if (String(claim.to_external_id) !== me) {
    return refuse();
  }

  await reply(
    ctx,
    siteAcc?.id
      ? [head, '', `It is for you. Receive it: ${cmd(ctx, 'claim')}`].join('\n')
      : [head, '', 'It is for you. Create a Flizy account and link this Telegram to receive it:', page].join('\n')
  );
}

async function handleClaimsList(ctx, user, account, kind) {
  if (kind === 'outgoing') {
    return handleCancelClaims(ctx, user, account, null);
  }

  const siteAcc = await resolveLinkedSiteAccount(ctx, account);
  if (!siteAcc?.id) {
    await reply(
      ctx,
      [
        `Link ${channelName(ctx)} to your Flizy account to see claims for your number.`,
        `Open ${config.siteUrl}/dashboard → generate code → ${cmd(ctx, 'link CODE')}`,
      ].join('\n')
    );
    return;
  }

  let claims;
  let identity;
  try {
    identity = await resolveClaimIdentity(ctx);
    claims = await listIncomingPending(identity);
  } catch (err) {
    console.error('listIncomingPending:', publicErrorMessage(err));
    await reply(ctx, 'Could not load claims. Try again.');
    return;
  }

  if (!claims.length && !identity.waPhone) {
    await reply(
      ctx,
      isTelegram(ctx)
        ? [
            'No claims found yet.',
            '',
            'A claim sent to your phone needs your number, and Telegram has not shared it.',
            'Send /phone and tap the button to share it (Telegram verifies the number).',
          ].join('\n')
        : [
            'No pending claims for this WhatsApp.',
            '',
            'Could not read your phone number from WhatsApp (LID-only session).',
            'A claim sent to your phone needs it. Re-link after updating the bot, or ask the sender to confirm the number.',
          ].join('\n')
    );
    return;
  }

  if (!claims.length) {
    await reply(ctx, 'No pending claims for you right now.');
    return;
  }
  await attachSenderLabels(claims);

  if (claims.length === 1) {
    pendingClaimMenus.set(ctx.key, {
      mode: 'claim',
      claims,
      createdAt: Date.now(),
      awaitConfirmId: claims[0].id,
    });
    await reply(
      ctx,
      ['Receive this claim?', formatClaimAmount(claims[0]), '', 'Reply: confirm', 'Or: cancel'].join(
        '\n'
      ),
      { buttons: confirmButtons() }
    );
    return;
  }

  pendingClaimMenus.set(ctx.key, { mode: 'claim', claims, createdAt: Date.now() });
  await reply(ctx, formatClaimsMenu(claims, 'incoming'));
}

async function runCancelOneClaim(ctx, account, claimId) {
  const siteAcc = await resolveLinkedSiteAccount(ctx, account);
  if (!siteAcc?.id) {
    await reply(ctx, 'Link your site account first.');
    return;
  }
  await reply(ctx, 'Refunding claim...');
  const result = await executeClaimRefund({
    claimId,
    fromAccountId: siteAcc.id,
    provider,
    chain,
    escrowWallet,
  });
  if (!result.ok) {
    await reply(ctx, result.error || 'Cancel failed.');
    return;
  }
  await reply(
    ctx,
    [
      'Claim cancelled. Funds returned to your Flizy wallet.',
      result.claim
        ? `Was for ${claimRecipientLabel(result.claim)} (${formatClaimAmount(result.claim)})`
        : null,
      result.explorerUrl || null,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

async function runPayoutOneClaim(ctx, user, account, claimId) {
  const siteAcc = await resolveLinkedSiteAccount(ctx, account);
  if (!siteAcc?.id) {
    await reply(
      ctx,
      `Link ${channelName(ctx)} to your Flizy account first to receive claims.\n${cmd(ctx, 'link CODE')}`
    );
    return;
  }
  await reply(ctx, 'Claiming funds...');
  const identity = await resolveClaimIdentity(ctx);
  const result = await executeClaimPayout({
    claimId,
    toAccountId: siteAcc.id,
    toWaSender: identity.waSenderId,
    toWaPhone: identity.waPhone,
    provider,
    chain,
    escrowWallet,
  });
  if (!result.ok) {
    await reply(ctx, result.error || 'Claim failed.');
    return;
  }
  await reply(
    ctx,
    [
      'Claim received.',
      `${formatClaimAmount(result.claim)} → your Flizy wallet`,
      result.explorerUrl || null,
      '',
      `Check: ${cmd(ctx, 'balance')}`,
    ]
      .filter(Boolean)
      .join('\n')
  );

  // Original sender hears on every linked channel (WA + TG), same idea as
  // request paid-notify. Claimer already has the receipt in this chat.
  // Copy always pairs who claimed with the original address path (e.g. GitHub
  // @rudazy) so the sender is not confused about which hold was paid out.
  const senderAccountId = result.claim?.from_account_id;
  if (senderAccountId) {
    try {
      const byLabel = await senderLabel(siteAcc.id);
      await notifyAccount(
        senderAccountId,
        formatClaimClaimedNotice({
          amountEth: result.claim.amount_eth,
          asset: result.claim.asset,
          nftTokenId: result.claim.nft_token_id,
          byLabel,
          viaLine: claimViaLine(result.claim),
          explorerUrl: result.explorerUrl || null,
        }),
        { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
      );
    } catch (err) {
      console.warn('claim claimed notify:', publicErrorMessage(err));
    }
  }
  if (!result.claim?.nft_token_id && senderAccountId !== siteAcc.id && result.claimTxHash) {
    try {
      const { requestPaymentNotice } = require('../paymentNotice');
      await requestPaymentNotice(siteAcc.id, {
        txHash: result.claimTxHash,
        amount: result.claim.amount_eth,
        asset: result.claim.asset || 'ETH',
        fromLabel: 'a held claim',
      });
    } catch (err) {
      console.warn('claim received notice:', publicErrorMessage(err));
    }
  }
}

async function notifyIncomingAfterLink(ctx) {
  try {
    const identity = await resolveClaimIdentity(ctx);
    const claims = await listIncomingPending(identity);
    const requests = await listIncomingRequests(identity);
    const parts = [];
    if (claims.length) {
      parts.push(`${claims.length} pending claim(s). Receive: ${cmd(ctx, 'claim')}`);
    }
    if (requests.length) {
      parts.push(`${requests.length} payment request(s). Pay: ${cmd(ctx, 'pay')}`);
    }
    if (!parts.length) return;
    await reply(ctx, ['After link, waiting for you:', ...parts.map((p) => `• ${p}`)].join('\n'));
  } catch (err) {
    console.warn('notifyIncomingAfterLink:', publicErrorMessage(err));
  }
}

module.exports = {
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
  handleClaimStart,
  runCancelOneClaim,
  runPayoutOneClaim,
  notifyIncomingAfterLink,
};
