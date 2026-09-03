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
const { chain, provider, escrowWallet, addressUrl } = require('../runtime');
const { publicErrorMessage } = require('../sanitize');
const {
  reply,
  cmd,
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
} = require('../claims');
const {
  platformRecipient,
  emailRecipient,
  telegramPendingUsernameRecipient,
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
const { resolveListedSendAsset } = require('../dex');
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
    tokenBalance = ethers.formatUnits(bal, Number(dec));
  }
  return { fromAddress, fromBalanceEth, tokenBalance };
}

async function resolveClaimListedAsset(ctx, sendAsset) {
  try {
    return resolveListedSendAsset(sendAsset, chain.id);
  } catch (err) {
    await reply(ctx, err.message || `Unknown token ${sendAsset}. Listed: ETH, FLZ.`);
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

  const funded = assertPlanFunded(plan, funds.fromBalanceEth, config.gasBufferEth, {
    tokenBalance: funds.tokenBalance,
    nftOwned,
  });
  if (!funded.ok) {
    await reply(ctx, [funded.message, addressUrl(funds.fromAddress)].filter(Boolean).join('\n'));
    return;
  }

  pendingSends.set(ctx.key, { plan, createdAt: Date.now() });
  await reply(ctx, formatClaimPlanPreview(plan), { buttons: confirmButtons() });
}

/**
 * How the recipient unlocks a platform claim (channel-specific).
 * @param {string|null|undefined} channel
 */
function platformClaimLinkHowTo(channel) {
  const ch = String(channel || '').toLowerCase();
  if (ch === 'github') {
    return 'They receive after they link GitHub on Flizy (Account → Platforms → Link GitHub), then flizy claim or claim on the site.';
  }
  if (ch === 'discord') {
    return 'They receive after they link Discord on Flizy (Account → Platforms → Link Discord), then flizy claim or claim on the site.';
  }
  if (ch === 'x') {
    return 'They receive after they link X on Flizy (Account → Platforms → Link X), then flizy claim or claim on the site.';
  }
  if (ch === 'telegram') {
    return 'They receive after they open the Flizy Telegram bot, link with a site code (link CODE) using the same Telegram account, then flizy claim or claim on the site. Their @username is saved on link so this hold matches. After that, the Telegram account stays tied to their Flizy account until they unlink.';
  }
  return 'They receive after they link that platform on Flizy (Account → Platforms), then flizy claim or claim on the site.';
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
async function notifyClaimTarget(ctx, toWaHint, amountEth, fromAccountId, identity, asset, nftTokenId) {
  try {
    const from = await senderLabel(ctx, fromAccountId, identity);
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
        'Receive it: flizy claim',
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
  identity,
  asset,
  nftTokenId
) {
  try {
    const bound = await getAccountByIdentity(channel, externalId);
    if (!bound?.account?.id) return false;
    const from = await senderLabel(ctx, fromAccountId, identity);
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
        'Receive it: flizy claim',
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
async function notifyClaimEmailTarget(ctx, email, amountEth, fromAccountId, identity, asset, nftTokenId) {
  try {
    const accountId = await findAccountIdByEmail(email);
    if (!accountId) return false;
    const from = await senderLabel(ctx, fromAccountId, identity);
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
        'Receive it: flizy claim (chat) or Claim on the site',
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

  if (!claims.length) {
    await reply(
      ctx,
      phoneFilter
        ? `No pending claims to +${phoneFilter}.`
        : `No pending claims.\nSend to a phone: ${cmd(ctx, 'send 0.001 to 2348012345678')}`
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
        '',
        'Reply: confirm',
        'Or: cancel',
      ].join('\n'),
      { buttons: confirmButtons() }
    );
    return;
  }

  pendingClaimMenus.set(ctx.key, { mode: 'cancel', claims, createdAt: Date.now() });
  await reply(ctx, formatClaimsMenu(claims, 'outgoing'));
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
            'Claims are addressed by phone number, and Telegram has not shared yours.',
            'Send /phone and tap the button to share it (Telegram verifies the number).',
          ].join('\n')
        : [
            'No pending claims for this WhatsApp.',
            '',
            'Could not read your phone number from WhatsApp (LID-only session).',
            'Claims are addressed by phone. Re-link after updating the bot, or ask the sender to confirm the number.',
          ].join('\n')
    );
    return;
  }

  if (!claims.length) {
    await reply(ctx, 'No pending claims for your number.');
    return;
  }

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
      const byLabel = await senderLabel(ctx, siteAcc.id, identity);
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
  runCancelOneClaim,
  runPayoutOneClaim,
  notifyIncomingAfterLink,
};
