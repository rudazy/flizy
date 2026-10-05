/**
 * Command parsing: raw chat text in, a typed intent out.
 *
 * Pure by construction. Nothing here reads the database, touches a pending
 * flow, or knows what a ctx is -- every function is a function of its
 * arguments alone. That is what makes this the one part of the command
 * path that can be exhaustively tested without mocking anything, and it is why
 * it was pulled out of router.js: the file had grown past 5,900 lines and the
 * parsers were 729 of them, sitting between the pending-flow state above and
 * the handlers below with no boundary a reader could see.
 *
 * The extraction was mechanical -- no function changed, no regex changed.
 * Additions since then stay in this file under the purity rule below.
 *
 * RULE FOR ANYTHING ADDED HERE: it must stay pure. The moment a parser needs
 * an account, a balance or a chain read, it is not a parser -- it is a
 * resolver, and it belongs with the handlers.
 */

const { parseEmail, isValidEmail } = require('../email');
const { interpretPhoneInput } = require('../phone');
const { listedSendSymbols } = require('../dex');
const { isPayCodeFormat, normalizePayCode } = require('../payCode');
const { normalizeNftTokenId } = require('../listedNfts');
const { ethers } = require('ethers');
const { canonicalizeCommand } = require('../commandAliases');
const { parseUnlockCommand, parseLockCommand } = require('../prefix');
const { normalizeAmount, unsupportedCurrencyCommand } = require('./amount');
// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * The one place a captured amount becomes a usable number.
 *
 * Every parser below captures an amount with the same widened character
 * class, which accepts grouping (`10,000`) and therefore also accepts
 * nonsense (`1,,2`). Rather than validate at twenty-seven capture sites, each
 * parser hands its result through here: grouping is stripped, a malformed
 * amount fails the whole parse, and every existing return shape is untouched.
 *
 * A parse that fails here reads to the router exactly like a parse that never
 * matched, which is the behaviour a malformed amount should have.
 *
 * @param {object|null} result
 * @param {string} field name of the amount property on the result
 * @returns {object|null}
 */
function withNormalizedAmount(result, field) {
  if (!result) return null;
  const raw = result[field];
  if (raw == null) return result;
  const value = normalizeAmount(raw);
  if (value === null) return null;
  return value === raw ? result : { ...result, [field]: value };
}

/**
 * Did the sender name an asset, or did we default to ETH?
 *
 * Every send shape is `<verb> <amount> [asset] to <target>`, so the token
 * after the amount is either a ticker or the word "to". The parsers cannot
 * answer this themselves: the bare shapes match `(?:eth)?` non-capturing, so
 * `send 1 to bob` and `send 1 eth to bob` are indistinguishable in their
 * output. Reading the original text is cheaper and safer than renumbering
 * capture groups across sixteen patterns.
 *
 * @param {string} text
 * @returns {boolean}
 */
function assetWasNamed(text) {
  const m = String(text || '')
    .trim()
    .match(/^\S+\s+[0-9,]*\.?[0-9]+\s+([a-zA-Z][a-zA-Z0-9]{0,9})\b/);
  return Boolean(m) && m[1].toLowerCase() !== 'to';
}

/**
 * send 0.01 to 0x... | send 0.01 to ama | send 0.01 eth to ama
 * send 10 FLZ to ama | send 10 FLZ to @user on telegram (listed tokens, same hold as ETH)
 * send 0.01 to github:octocat | send 0.01 eth to github:octocat
 * @returns {{
 *   amountEth: string,
 *   asset: string,
 *   toRaw: string,
 *   isAddress: boolean,
 *   isPhone: boolean,
 *   platform?: string|null,
 * } | null}
 */
/** @param {string} raw */
function normalizePlatformName(raw) {
  const p = String(raw || '')
    .trim()
    .toLowerCase();
  if (p === 'twitter') return 'x';
  if (p === 'tg') return 'telegram';
  if (p === 'gh') return 'github';
  if (p === 'dc') return 'discord';
  if (p === 'github' || p === 'discord' || p === 'x' || p === 'telegram') return p;
  return null;
}

/** Platforms accepted in "to @user on …" / "platform:user" send syntax. */
const SEND_PLATFORM_RE = 'github|discord|x|twitter|telegram|tg|gh|dc';

/**
 * A phone target: leading plus optional, then digits with spaces, dashes,
 * dots or brackets. The length check lives in interpretPhoneInput, so a
 * Flizy number (nine digits) falls through to the pay-code branch.
 */
const PHONE_TARGET_RE = '\\+?[0-9][0-9\\s().-]*[0-9]';

/**
 * @param {string} target the text after "to" or "from"
 * @returns {{ toRaw: string, isPhone: true, phoneNeedsCountry?: boolean, nationalDigits?: string } | null}
 */
function asPhoneTarget(target) {
  const read = interpretPhoneInput(target);
  if (read.status === 'e164') return { toRaw: read.e164, isPhone: true };
  if (read.status === 'needs_country') {
    return {
      toRaw: String(target || '').trim(),
      isPhone: true,
      phoneNeedsCountry: true,
      nationalDigits: read.national,
    };
  }
  return null;
}

function parseSendCommand(text) {
  const r = withNormalizedAmount(parseSendCommandRaw(text), 'amountEth');
  return r ? { ...r, assetExplicit: assetWasNamed(text) } : null;
}

function parseSendCommandRaw(text) {
  const t = String(text || '').trim();

  // Email before phone/alias so user@domain is never treated as a phone fragment.
  // Preferred: send 0.001 to you@email.com | send 0.001 eth to you@email.com
  // Also: email:you@email.com and asset forms.
  const assetEmailColon = t.match(
    /^send\s+([0-9,]*\.?[0-9]+)\s+([a-zA-Z][a-zA-Z0-9]{0,9})\s+to\s+email:([^\s]+)\b/i
  );
  if (assetEmailColon && isValidEmail(assetEmailColon[3])) {
    return {
      amountEth: assetEmailColon[1],
      asset: normalizeSendAsset(assetEmailColon[2]),
      toRaw: parseEmail(assetEmailColon[3]),
      isAddress: false,
      isPhone: false,
      platform: null,
      isEmail: true,
    };
  }
  const assetEmail = t.match(
    /^send\s+([0-9,]*\.?[0-9]+)\s+([a-zA-Z][a-zA-Z0-9]{0,9})\s+to\s+([^\s]+@[^\s]+)\b/i
  );
  if (assetEmail && isValidEmail(assetEmail[3])) {
    return {
      amountEth: assetEmail[1],
      asset: normalizeSendAsset(assetEmail[2]),
      toRaw: parseEmail(assetEmail[3]),
      isAddress: false,
      isPhone: false,
      platform: null,
      isEmail: true,
    };
  }
  const emailColon = t.match(
    /^send\s+([0-9,]*\.?[0-9]+)\s*(?:eth)?\s+to\s+email:([^\s]+)\b/i
  );
  if (emailColon && isValidEmail(emailColon[2])) {
    return {
      amountEth: emailColon[1],
      asset: 'ETH',
      toRaw: parseEmail(emailColon[2]),
      isAddress: false,
      isPhone: false,
      platform: null,
      isEmail: true,
    };
  }
  const emailTo = t.match(
    /^send\s+([0-9,]*\.?[0-9]+)\s*(?:eth)?\s+to\s+([^\s]+@[^\s]+)\b/i
  );
  if (emailTo && isValidEmail(emailTo[2])) {
    return {
      amountEth: emailTo[1],
      asset: 'ETH',
      toRaw: parseEmail(emailTo[2]),
      isAddress: false,
      isPhone: false,
      platform: null,
      isEmail: true,
    };
  }

  // Explicit asset: send 10 FLZ to ...
  const assetAddr = t.match(
    /^send\s+([0-9,]*\.?[0-9]+)\s+([a-zA-Z][a-zA-Z0-9]{0,9})\s+to\s+(0x[a-fA-F0-9]{40})\b/i
  );
  if (assetAddr) {
    return {
      amountEth: assetAddr[1],
      asset: normalizeSendAsset(assetAddr[2]),
      toRaw: assetAddr[3],
      isAddress: true,
      isPhone: false,
      platform: null,
      isEmail: false,
    };
  }
  const assetPhone = t.match(
    new RegExp(
      `^send\\s+([0-9,]*\\.?[0-9]+)\\s+([a-zA-Z][a-zA-Z0-9]{0,9})\\s+to\\s+(${PHONE_TARGET_RE})\\s*$`,
      'i'
    )
  );
  if (assetPhone) {
    const phone = asPhoneTarget(assetPhone[3]);
    if (phone) {
      return {
        amountEth: assetPhone[1],
        asset: normalizeSendAsset(assetPhone[2]),
        isAddress: false,
        platform: null,
        isEmail: false,
        ...phone,
      };
    }
  }
  // Pay code with a named asset: "send 10 FLZ to 123456789".
  //
  // Sits right after the phone branch because that is the shape it must never
  // be confused with, and it provably cannot be: assetPhone takes 10-15 digits
  // and a pay code is 9. That is the same floor keeping a bare code out of the
  // phone flow, doing the same job one branch further down.
  //
  // Grouping is accepted ("123 456 789") because the code is printed grouped,
  // and normalised away before it leaves here so every lookup sees one form.
  const assetPayCode = t.match(
    /^send\s+([0-9,]*\.?[0-9]+)\s+([a-zA-Z][a-zA-Z0-9]{0,9})\s+to\s+([0-9][0-9\s-]*[0-9])\s*$/i
  );
  if (assetPayCode && isPayCodeFormat(assetPayCode[3])) {
    return {
      amountEth: assetPayCode[1],
      asset: normalizeSendAsset(assetPayCode[2]),
      toRaw: normalizePayCode(assetPayCode[3]),
      isAddress: false,
      isPhone: false,
      platform: null,
    };
  }
  // Platform before bare alias: "to @user on github|discord|x|telegram"
  const assetPlatformOn = t.match(
    new RegExp(
      `^send\\s+([0-9,]*\\.?[0-9]+)\\s+([a-zA-Z][a-zA-Z0-9]{0,9})\\s+to\\s+@?([a-zA-Z0-9_.-]{1,39})\\s+on\\s+(${SEND_PLATFORM_RE})\\b`,
      'i'
    )
  );
  if (assetPlatformOn) {
    return {
      amountEth: assetPlatformOn[1],
      asset: normalizeSendAsset(assetPlatformOn[2]),
      toRaw: assetPlatformOn[3],
      isAddress: false,
      isPhone: false,
      platform: normalizePlatformName(assetPlatformOn[4]),
    };
  }
  const assetPlatformColon = t.match(
    new RegExp(
      `^send\\s+([0-9,]*\\.?[0-9]+)\\s+([a-zA-Z][a-zA-Z0-9]{0,9})\\s+to\\s+(${SEND_PLATFORM_RE}):([a-zA-Z0-9_.-]{1,39})\\b`,
      'i'
    )
  );
  if (assetPlatformColon) {
    return {
      amountEth: assetPlatformColon[1],
      asset: normalizeSendAsset(assetPlatformColon[2]),
      toRaw: assetPlatformColon[4],
      isAddress: false,
      isPhone: false,
      platform: normalizePlatformName(assetPlatformColon[3]),
    };
  }
  const assetAlias = t.match(
    /^send\s+([0-9,]*\.?[0-9]+)\s+([a-zA-Z][a-zA-Z0-9]{0,9})\s+to\s+@?([a-zA-Z][a-zA-Z0-9_]{0,31})\b/i
  );
  if (assetAlias) {
    return {
      amountEth: assetAlias[1],
      asset: normalizeSendAsset(assetAlias[2]),
      toRaw: assetAlias[3],
      isAddress: false,
      isPhone: false,
      platform: null,
    };
  }

  // Native ETH (optional "eth" word)
  const addr = t.match(/^send\s+([0-9,]*\.?[0-9]+)\s*(?:eth)?\s+to\s+(0x[a-fA-F0-9]{40})\b/i);
  if (addr) {
    return {
      amountEth: addr[1],
      asset: 'ETH',
      toRaw: addr[2],
      isAddress: true,
      isPhone: false,
      platform: null,
    };
  }
  const phone = t.match(
    new RegExp(
      `^send\\s+([0-9,]*\\.?[0-9]+)\\s*(?:eth)?\\s+to\\s+(${PHONE_TARGET_RE})\\s*$`,
      'i'
    )
  );
  if (phone) {
    const target = asPhoneTarget(phone[2]);
    if (target) {
      return {
        amountEth: phone[1],
        asset: 'ETH',
        isAddress: false,
        platform: null,
        ...target,
      };
    }
  }
  // Preferred UX: send 0.001 to @user on github|discord|x|telegram
  const platformOn = t.match(
    new RegExp(
      `^send\\s+([0-9,]*\\.?[0-9]+)\\s*(?:eth)?\\s+to\\s+@?([a-zA-Z0-9_.-]{1,39})\\s+on\\s+(${SEND_PLATFORM_RE})\\b`,
      'i'
    )
  );
  if (platformOn) {
    return {
      amountEth: platformOn[1],
      asset: 'ETH',
      toRaw: platformOn[2],
      isAddress: false,
      isPhone: false,
      platform: normalizePlatformName(platformOn[3]),
    };
  }
  // Shorthand: send 0.001 to github:user | discord:id | x:handle | telegram:user
  const platformColon = t.match(
    new RegExp(
      `^send\\s+([0-9,]*\\.?[0-9]+)\\s*(?:eth)?\\s+to\\s+(${SEND_PLATFORM_RE}):([a-zA-Z0-9_.-]{1,39})\\b`,
      'i'
    )
  );
  if (platformColon) {
    return {
      amountEth: platformColon[1],
      asset: 'ETH',
      toRaw: platformColon[3],
      isAddress: false,
      isPhone: false,
      platform: normalizePlatformName(platformColon[2]),
    };
  }
  const alias = t.match(
    /^send\s+([0-9,]*\.?[0-9]+)\s*(?:eth)?\s+to\s+@?([a-zA-Z][a-zA-Z0-9_]{0,31})\b/i
  );
  if (alias) {
    return {
      amountEth: alias[1],
      asset: 'ETH',
      toRaw: alias[2],
      isAddress: false,
      isPhone: false,
      platform: null,
    };
  }
  // A pay code is a run of digits, optionally grouped the way it is printed
  // ("012 345 678"). The length is not asserted here: isPayCodeFormat strips the
  // grouping and is the one place that knows how long a code is. This branch
  // sits last on purpose -- anything long enough to be a phone matched earlier,
  // and a code is deliberately too short to reach that branch at all.
  const payCode = t.match(
    /^send\s+([0-9,]*\.?[0-9]+)\s*(?:eth)?\s+to\s+([0-9][0-9\s-]*[0-9])\s*$/i
  );
  if (payCode && isPayCodeFormat(payCode[2])) {
    return {
      amountEth: payCode[1],
      asset: 'ETH',
      // Stored without the grouping, so every lookup downstream sees one form.
      toRaw: normalizePayCode(payCode[2]),
      isAddress: false,
      isPhone: false,
      platform: null,
    };
  }
  return null;
}

/**
 * nft send giwaforge 1842 to @bob on telegram
 * Same recipient shapes as parseSendCommand. Prefix is the parser lock so a
 * collection ticker cannot be read as a listed token.
 *
 * @returns {(ReturnType<typeof parseSendCommand> & {
 *   isNft: true,
 *   nftTicker: string,
 *   nftTokenId: string,
 * }) | null}
 */
function parseNftSendCommand(text) {
  const t = String(text || '').trim();
  const m = t.match(
    /^nft\s+send\s+([a-zA-Z][a-zA-Z0-9]{0,31})\s+(#?[0-9]{1,78}(?:\s+#?[0-9]{1,78})*)\s+to\s+(.+)$/i
  );
  if (!m) return null;
  const tokenIds = parseNftTokenIdList(m[2]);
  if (!tokenIds) return null;
  const inner = parseSendCommand(`send 1 ETH to ${String(m[3] || '').trim()}`);
  if (!inner) return null;
  return {
    ...inner,
    amountEth: '1',
    asset: m[1].toUpperCase(),
    isNft: true,
    nftTicker: m[1].toLowerCase(),
    // One id keeps the original single-send shape so nothing downstream changes.
    nftTokenId: tokenIds[0],
    nftTokenIds: tokenIds,
  };
}

/**
 * A whitespace-separated run of token ids, e.g. "1123 #1128 1131".
 *
 * Null only when an id is malformed, which is a parse failure. A repeated id
 * parses fine and is left for the handler to refuse by name — "Unknown command"
 * would tell the sender nothing about what was actually wrong.
 *
 * @param {string} raw
 * @returns {string[]|null}
 */
function parseNftTokenIdList(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const part of parts) {
    const id = normalizeNftTokenId(part);
    if (id == null) return null;
    out.push(id);
  }
  return out;
}

/** The first id named twice in a list, or null. */
function firstDuplicateId(ids) {
  const seen = new Set();
  for (const id of ids || []) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

/**
 * The shapes a named-asset send can take, compiled once.
 *
 * "nft" is a word people put wherever it reads naturally, so all placements
 * mean the same thing and all of them pin the collection rather than a token
 * that happens to share the ticker. Ordered longest-first: the plain shape
 * would otherwise read "nft" itself as the ticker.
 */
const NAMED_ASSET_SHAPES = (() => {
  const COUNT = '(?:(?<count>[0-9]{1,3})\\s+)?';
  const TICKER = '(?<ticker>[a-zA-Z][a-zA-Z0-9]{0,31})';
  const IDS = '(?:\\s+(?<ids>#?[0-9]{1,78}(?:\\s+#?[0-9]{1,78})*))?';
  const DEST = '\\s+to\\s+(?<dest>.+)$';
  return [
    { src: `^nft\\s+send\\s+${COUNT}${TICKER}${IDS}${DEST}`, nftOnly: true },
    { src: `^send\\s+${COUNT}nfts?\\s+${TICKER}${IDS}${DEST}`, nftOnly: true },
    { src: `^send\\s+${COUNT}${TICKER}\\s+nfts?${DEST}`, nftOnly: true },
    { src: `^send\\s+${COUNT}${TICKER}${IDS}${DEST}`, nftOnly: false },
  ].map(({ src, nftOnly }) => ({ re: new RegExp(src, 'i'), nftOnly }));
})();

/**
 * send giwaforge to you@email.com
 * nft send giwaforge to @bob on telegram
 * send 2 giwaforge to @bob on telegram
 * send 2 giwaforge 1123 1128 to @bob on telegram
 *
 * No amount and no token id: look up what the wallet actually holds, then ask
 * token vs NFT (if both) and which token id (if several NFTs).
 *
 * A leading number is a count of NFTs, never a token id. The by-id form puts
 * the id after the ticker, so `2 giwaforge` and `giwaforge 2` stay distinct and
 * one reply can never mean two different things.
 *
 * @returns {{
 *   ticker: string,
 *   count: number|null,
 *   ids: string[]|null,
 *   nftOnly: boolean,
 *   toRaw: string,
 *   isAddress: boolean,
 *   isPhone: boolean,
 *   isEmail: boolean,
 *   platform: string|null,
 * } | null}
 */
function parseSendNamedAssetCommand(text) {
  const t = String(text || '').trim();

  let g = null;
  let nftOnly = false;
  for (const shape of NAMED_ASSET_SHAPES) {
    const m = t.match(shape.re);
    if (m) {
      g = m.groups;
      nftOnly = shape.nftOnly;
      break;
    }
  }
  if (!g) return null;

  const hasCount = g.count != null;
  const ticker = g.ticker.toLowerCase();

  // A counted listed token is an ordinary fungible send and belongs to
  // parseSendCommand. Bailing here is what keeps `send 2 FLZ to bob` on the
  // path it has always taken. The amount-less `send flz to bob` still lands
  // here and still gets asked how much.
  if (hasCount && LISTED_SEND_SYMBOLS.has(normalizeSendAsset(ticker))) return null;

  const ids = g.ids ? parseNftTokenIdList(g.ids) : null;
  if (g.ids && !ids) return null;

  const inner = parseSendCommand(`send 1 ETH to ${String(g.dest || '').trim()}`);
  if (!inner) return null;
  return {
    ticker,
    // Zero and a count that disagrees with the ids are parsed so the handler
    // can refuse them by name, the way parseMintCommand does.
    count: hasCount ? Number(g.count) : null,
    ids,
    nftOnly,
    toRaw: inner.toRaw,
    isAddress: Boolean(inner.isAddress),
    isPhone: Boolean(inner.isPhone),
    isEmail: Boolean(inner.isEmail),
    platform: inner.platform || null,
  };
}

/**
 * mint 1 giwaforge | mint giwaforge | mint 1 giwaforge nft | nft mint giwaforge
 * One per wallet. Count other than 1 is parsed so the handler can refuse it.
 * Trailing "nft" is filler, not a second product.
 * @returns {{ ticker: string, count: number } | null}
 */
function parseMintCommand(text) {
  const t = String(text || '').trim();
  const nftEnd = '(?:\\s+nft)?\\s*$';
  let m = t.match(new RegExp(`^(?:nft\\s+)?mint\\s+1\\s+([a-zA-Z][a-zA-Z0-9]{0,31})${nftEnd}`, 'i'));
  if (m) return { ticker: m[1].toLowerCase(), count: 1 };
  m = t.match(new RegExp(`^(?:nft\\s+)?mint\\s+([a-zA-Z][a-zA-Z0-9]{0,31})${nftEnd}`, 'i'));
  if (m) return { ticker: m[1].toLowerCase(), count: 1 };
  m = t.match(new RegExp(`^(?:nft\\s+)?mint\\s+([0-9]+)\\s+([a-zA-Z][a-zA-Z0-9]{0,31})${nftEnd}`, 'i'));
  if (m) return { ticker: m[2].toLowerCase(), count: Number(m[1]) };
  return null;
}

/** pay 0.01 for coffee — amount first, identity next message */
function parsePayAskCommand(text) {
  return withNormalizedAmount(parsePayAskCommandRaw(text), 'amountEth');
}

function parsePayAskCommandRaw(text) {
  const t = String(text || '').trim();
  const m = t.match(/^pay\s+([0-9,]*\.?[0-9]+)\s*(?:eth)?\s+for\s+(.+)$/i);
  if (!m) return null;
  const note = String(m[2] || '').trim();
  if (!note || /^to\b/i.test(note)) return null;
  return { amountEth: m[1], note };
}

function normalizeSendAsset(raw) {
  const s = String(raw || 'ETH').toUpperCase();
  if (s === 'ETH' || s === 'NATIVE' || s === 'ETHER') return 'ETH';
  if (s === 'FLIZY') return 'FLZ';
  return s;
}

/** Tickers that a count in front of makes an ordinary fungible send. */
const LISTED_SEND_SYMBOLS = new Set(listedSendSymbols());

function isNativeSendAsset(asset) {
  const s = String(asset || 'ETH').toUpperCase();
  return s === 'ETH' || s === 'NATIVE' || s === 'ETHER';
}

/**
 * price FLZ | buy 100 FLZ | buy 0.1 ETH of FLZ | sell 10 FLZ
 * swap 0.01 ETH for FLZ | trade 100 FLZ
 *
 * amountMode says which side of the trade the amount names:
 *   'in'  the amount is what you spend  (buy 0.1 ETH of FLZ, sell, swap)
 *   'out' the amount is what you receive (buy 100 FLZ)
 * The unit follows the symbol the user typed, so "buy 100 flz" gets 100 FLZ
 * rather than spending 100 ETH. Loose phrasing is canonicalized upstream by
 * lib/commandAliases.js, so this stays one shape per line.
 *
 * @returns {{
 *   kind: 'buy'|'sell'|'swap'|'price'|'trade_ambiguous',
 *   amountMode?: 'in'|'out',
 *   amount?: string,
 *   tokenIn?: string,
 *   tokenOut?: string,
 *   symbol?: string,
 * } | null}
 */
function parseSwapCommand(text) {
  return withNormalizedAmount(parseSwapCommandRaw(text), 'amount');
}

function parseSwapCommandRaw(text) {
  const t = String(text || '').trim();
  let m = t.match(/^price\s+([a-zA-Z0-9]+)\s*$/i);
  if (m) return { kind: 'price', symbol: m[1] };

  // "buy 0.1 eth of flz" — the amount is the spend, unit named explicitly.
  m = t.match(/^buy\s+([0-9,]*\.?[0-9]+)\s+([a-zA-Z0-9]+)\s+of\s+([a-zA-Z0-9]+)\s*$/i);
  if (m) {
    return { kind: 'buy', amountMode: 'in', amount: m[1], tokenIn: m[2], tokenOut: m[3] };
  }

  // "buy 100 flz" — the amount is the token you want to end up holding.
  m = t.match(/^buy\s+([0-9,]*\.?[0-9]+)\s+([a-zA-Z0-9]+)\s*$/i);
  if (m) return { kind: 'buy', amountMode: 'out', amount: m[1], tokenOut: m[2] };

  m = t.match(/^sell\s+([0-9,]*\.?[0-9]+)\s+([a-zA-Z0-9]+)\s*$/i);
  if (m) return { kind: 'sell', amountMode: 'in', amount: m[1], tokenIn: m[2] };

  m = t.match(/^swap\s+([0-9,]*\.?[0-9]+)\s+([a-zA-Z0-9]+)\s+for\s+([a-zA-Z0-9]+)\s*$/i);
  if (m) {
    return { kind: 'swap', amountMode: 'in', amount: m[1], tokenIn: m[2], tokenOut: m[3] };
  }

  // "trade 100 flz" — one side only. Which way is genuinely unknown, so the
  // router asks instead of picking a side on someone's money.
  m = t.match(/^trade\s+([0-9,]*\.?[0-9]+)\s+([a-zA-Z0-9]+)\s*$/i);
  if (m) return { kind: 'trade_ambiguous', amount: m[1], symbol: m[2] };

  return null;
}

/** cancel claims | cancel claims 234... | cancel claims all */
function parseCancelClaimsCommand(text) {
  const m = String(text || '')
    .trim()
    .match(/^cancel\s+claims?(?:\s+(\+?\d{6,20}|all))?\s*$/i);
  if (!m) return null;
  const arg = m[1] ? String(m[1]).toLowerCase() : null;
  return { filter: arg === 'all' ? null : arg };
}

/** claims (list outgoing) | claim / claim incoming */
function parseClaimsListCommand(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t === 'claims' || t === 'claim list' || t === 'outgoing claims') {
    return { kind: 'outgoing' };
  }
  if (t === 'claim' || t === 'claim incoming' || t === 'incoming claims' || t === 'my claims') {
    return { kind: 'incoming' };
  }
  return null;
}

/** request 0.01 from 234… | request 0.01 from john */
/**
 * split 100 with @ada @kemi | split 0.03 with ada kemi for dinner
 *
 * The amount is the **whole bill**, not each share, because that is the number
 * printed on the receipt in front of you. It divides among the people named
 * plus you: "split 30 with ada and kemi" is three ways, ten each, and two
 * requests go out. Asking for the share instead would make the organiser do the
 * division, which is the one job a split bill exists to remove.
 *
 * Only the names are parsed here. Resolving them to accounts and dividing the
 * money is the handler's job -- this file stays pure.
 *
 * @param {string} text
 * @returns {{ amountEth: string, people: string[], note: string|null }|null}
 */
function parseSplitCommand(text) {
  return withNormalizedAmount(parseSplitCommandRaw(text), 'amountEth');
}

function parseSplitCommandRaw(text) {
  const t = String(text || '').trim();
  const m = t.match(
    /^split\s+([0-9,]*\.?[0-9]+)\s*(?:eth)?\s+(?:with|between|among)\s+(.+)$/i
  );
  if (!m) return null;

  let rest = m[2].trim();
  let note = null;

  // "for dinner" ends the name list. Split on the last one so a person called
  // "forster" is not read as the start of a note.
  const forAt = rest.search(/\s+for\s+(?!.*\s+for\s+)/i);
  if (forAt !== -1) {
    note = rest.slice(forAt).replace(/^\s+for\s+/i, '').trim() || null;
    rest = rest.slice(0, forAt).trim();
  }

  const people = rest
    .split(/[,\s]+|\band\b/i)
    .map((w) => w.trim().replace(/^@+/, ''))
    .filter(Boolean);

  if (!people.length) return null;
  // Every name must look like something the request path can resolve. A stray
  // word here would otherwise become a silent "no account called x".
  if (people.some((w) => !/^[a-zA-Z0-9_.@+-]{2,64}$/.test(w))) return null;

  const unique = [];
  for (const w of people) {
    const key = w.toLowerCase();
    if (!unique.some((u) => u.toLowerCase() === key)) unique.push(w);
  }

  return { amountEth: m[1], people: unique, note };
}
/**
 * collect 5 for rent | collect for team lunch | collect rent
 *
 * A pot is named first and paid into later, which is the whole reason it is a
 * row rather than a label on requests that do not exist yet.
 *
 * The amount is a **goal, not a cap**: it decides when the pot reads as funded
 * and nothing else. Refusing money someone tried to give would be worse than
 * overshooting, so nothing here treats it as a limit. It is optional, because a
 * thrift pot or a family vault collects without a finish line.
 *
 * @param {string} text
 * @returns {{ amountEth: string|null, name: string }|null}
 */
function parseCollectCommand(text) {
  return withNormalizedAmount(parseCollectCommandRaw(text), 'amountEth');
}

function parseCollectCommandRaw(text) {
  const t = String(text || '').trim();

  // Longest first: "collect 5 for rent" must not be read as a pot named "5 for rent".
  const withGoal = t.match(/^collect\s+([0-9,]*\.?[0-9]+)\s*(?:eth)?\s+for\s+(.+)$/i);
  if (withGoal) {
    const name = withGoal[2].trim();
    return name ? { amountEth: withGoal[1], name } : null;
  }

  const forOnly = t.match(/^collect\s+for\s+(.+)$/i);
  if (forOnly) {
    const name = forOnly[1].trim();
    return name ? { amountEth: null, name } : null;
  }

  const bare = t.match(/^collect\s+(.+)$/i);
  if (bare) {
    const name = bare[1].trim();
    // "collect 5" is a goal with nothing to call the pot, not a pot named "5".
    if (!name || /^[0-9,]*\.?[0-9]+\s*(?:eth)?$/i.test(name)) return null;
    return { amountEth: null, name };
  }

  return null;
}

/** pots | pot — the organiser's list. */
function parsePotsListCommand(text) {
  return /^(?:pots|pot)$/i.test(String(text || '').trim());
}

/**
 * pot <code> — one pot, for anyone holding the code.
 * @returns {{ code: string }|null}
 */
function parsePotCommand(text) {
  const m = String(text || '').trim().match(/^pot\s+([a-z0-9]{4,12})$/i);
  if (!m) return null;
  return { code: m[1].toLowerCase() };
}

/**
 * pay pot <code> 1.5 | pay 1.5 to pot <code>
 *
 * Kept distinct from the nine-digit pay code on purpose: both are "pay
 * something short", and the `pot` keyword is what stops one being read as the
 * other. See lib/pots.js for why the alphabets differ too.
 *
 * @returns {{ code: string, amountEth: string }|null}
 */
function parsePayPotCommand(text) {
  return withNormalizedAmount(parsePayPotCommandRaw(text), 'amountEth');
}

function parsePayPotCommandRaw(text) {
  const t = String(text || '').trim();

  const codeFirst = t.match(/^pay\s+pot\s+([a-z0-9]{4,12})\s+([0-9,]*\.?[0-9]+)\s*(?:eth)?$/i);
  if (codeFirst) return { code: codeFirst[1].toLowerCase(), amountEth: codeFirst[2] };

  const amountFirst = t.match(
    /^pay\s+([0-9,]*\.?[0-9]+)\s*(?:eth)?\s+(?:in)?to\s+pot\s+([a-z0-9]{4,12})$/i
  );
  if (amountFirst) return { code: amountFirst[2].toLowerCase(), amountEth: amountFirst[1] };

  return null;
}

/**
 * pay pot <code> with no amount. Parsed so the handler can say what is missing
 * instead of letting it fall through to "unknown command".
 * @returns {{ code: string }|null}
 */
function parsePayPotNoAmountCommand(text) {
  const t = String(text || '').trim();
  if (parsePayPotCommandRaw(t)) return null;
  const m = t.match(/^pay\s+pot\s+([a-z0-9]{4,12})$/i);
  if (!m) return null;
  return { code: m[1].toLowerCase() };
}

/** close pot <code> — stops new contributions. Moves no money. */
function parseClosePotCommand(text) {
  const m = String(text || '').trim().match(/^close\s+pot\s+([a-z0-9]{4,12})$/i);
  if (!m) return null;
  return { code: m[1].toLowerCase() };
}

/**
 * rename pot <code> <new name>
 * Renaming after the fact is one of the three reasons a pot is a table.
 * @returns {{ code: string, name: string }|null}
 */
function parseRenamePotCommand(text) {
  const m = String(text || '')
    .trim()
    .match(/^rename\s+pot\s+([a-z0-9]{4,12})\s+(.+)$/i);
  if (!m) return null;
  const name = m[2].trim();
  if (!name) return null;
  return { code: m[1].toLowerCase(), name };
}

function parseRequestCommand(text) {
  return withNormalizedAmount(parseRequestCommandRaw(text), 'amountEth');
}

/**
 * request 0.01 from 234… | from @ada | from @ada on telegram
 * request 0.01 from github:octocat | from ada@example.com
 *
 * The same set of targets a send understands, minus the raw address: a send
 * can move money to `0x…`, but a request has to reach a person who can be
 * told about it, and an address is nobody. The router refuses that shape by
 * name rather than letting it fall through to "unknown command".
 *
 * Shapes are tried longest-first so `from github:octocat` is not read as a
 * username called "github".
 */
function parseRequestCommandRaw(text) {
  const t = String(text || '').trim();
  const head = '^request\\s+([0-9,]*\\.?[0-9]+)\\s*(?:eth)?\\s+from\\s+';

  // email first: user@domain must never be read as a phone fragment or alias
  const email = t.match(new RegExp(`${head}(?:email:)?([^\\s]+@[^\\s]+)$`, 'i'));
  if (email && isValidEmail(email[2])) {
    return { amountEth: email[1], fromRaw: email[2], kind: 'email' };
  }

  const platformOn = t.match(
    new RegExp(
      `${head}@?([a-zA-Z0-9_.-]{1,39})\\s+on\\s+(${SEND_PLATFORM_RE})$`,
      'i'
    )
  );
  if (platformOn) {
    const platform = normalizePlatformName(platformOn[3]);
    if (platform) {
      return { amountEth: platformOn[1], fromRaw: platformOn[2], kind: 'platform', platform };
    }
  }

  const platformColon = t.match(
    new RegExp(`${head}(${SEND_PLATFORM_RE}):@?([a-zA-Z0-9_.-]{1,39})$`, 'i')
  );
  if (platformColon) {
    const platform = normalizePlatformName(platformColon[2]);
    if (platform) {
      return { amountEth: platformColon[1], fromRaw: platformColon[3], kind: 'platform', platform };
    }
  }

  const phone = t.match(new RegExp(`${head}(${PHONE_TARGET_RE})$`, 'i'));
  if (phone) {
    const target = asPhoneTarget(phone[2]);
    if (target) {
      return {
        amountEth: phone[1],
        fromRaw: target.toRaw,
        kind: 'phone',
        isPhone: true,
        phoneNeedsCountry: Boolean(target.phoneNeedsCountry),
        nationalDigits: target.nationalDigits,
      };
    }
  }

  // A raw address parses so the router can say why it is refused.
  const addr = t.match(new RegExp(`${head}(0x[a-fA-F0-9]{40})$`, 'i'));
  if (addr) {
    return { amountEth: addr[1], fromRaw: addr[2], kind: 'address' };
  }

  const alias = t.match(new RegExp(`${head}@?([a-zA-Z][a-zA-Z0-9_]{0,31})$`, 'i'));
  if (alias) {
    return { amountEth: alias[1], fromRaw: alias[2], kind: 'alias', isPhone: false };
  }

  return null;
}

/** requests | pay | cancel requests */
function parseRequestsCommand(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t === 'requests' || t === 'my requests' || t === 'cancel requests') {
    return { kind: t === 'cancel requests' ? 'cancel_out' : 'outgoing' };
  }
  if (t === 'pay' || t === 'pay request' || t === 'pay requests' || t === 'incoming requests') {
    return { kind: 'incoming' };
  }
  return null;
}

/** save ama 0x... | add ama 0x... | contact ama 0x... */
function parseSaveContactCommand(text) {
  const m = String(text || '').match(
    /^(?:save|add|contact)\s+([a-zA-Z][a-zA-Z0-9_]{0,31})\s+(0x[a-fA-F0-9]{40})\s*$/i
  );
  if (!m) return null;
  return { alias: m[1].toLowerCase(), address: m[2] };
}

/** remove ama | unsave ama | delete ama */
function parseRemoveContactCommand(text) {
  const m = String(text || '').match(/^(?:remove|unsave|delete)\s+([a-zA-Z][a-zA-Z0-9_]{0,31})\s*$/i);
  if (!m) return null;
  return { alias: m[1].toLowerCase() };
}

/** add wallet 0x... | add 0x... */
function parseAddWalletCommand(text) {
  const m = String(text || '').match(/^add(?:\s+wallet)?\s+(0x[a-fA-F0-9]{40})\s*$/i);
  if (!m) return null;
  return { address: m[1] };
}

/**
 * `cancel wallet` / `cancel wallet john` / `cancel wallet 0x...`
 *
 * The one authority-shaped thing chat may still do to the trusted list. It only
 * reaches destinations inside their 24 hour hold, and it removes power rather
 * than granting it, which is why a weaker channel is allowed to do it at all.
 *
 * No argument means every held destination, which is the right default when the
 * owner has just been told something was added and does not recognise it.
 */
function parseCancelTrustedCommand(text) {
  const m = String(text || '')
    .trim()
    .match(/^cancel\s+(?:wallet|address|destination)\s*(.*)$/i);
  if (!m) return null;
  const target = String(m[1] || '').trim();
  return { target: target || null };
}

function isValidTrustedName(name) {
  return /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(String(name || '').trim());
}

/** credit 234xxx 0.01 | credit 0.01 to 234xxx */
function parseCreditCommand(text) {
  return withNormalizedAmount(parseCreditCommandRaw(text), 'amountEth');
}

function parseCreditCommandRaw(text) {
  let m = String(text || '').match(/^credit\s+(\d{6,20})\s+([0-9,]*\.?[0-9]+)\s*(?:eth)?\s*$/i);
  if (m) return { phone: m[1], amountEth: m[2] };
  m = String(text || '').match(/^credit\s+([0-9,]*\.?[0-9]+)\s*(?:eth)?\s+to\s+(\d{6,20})\s*$/i);
  if (m) return { phone: m[2], amountEth: m[1] };
  return null;
}

/** claimadmin <secret> promotes yourself if ADMIN_SETUP_SECRET matches */
function parseClaimAdminCommand(text) {
  const m = String(text || '').match(/^claimadmin\s+(\S+)\s*$/i);
  if (!m) return null;
  return { secret: m[1] };
}

/** link A7K2QX (body after prefix is stripped) */
function parseLinkCommand(text) {
  const m = String(text || '').match(/^link\s+([A-Za-z0-9]{6,12})\s*$/i);
  if (!m) return null;
  return { code: m[1].toUpperCase() };
}

const isConfirmCommand = (text) => String(text || '').trim().toLowerCase() === 'confirm';
const isCancelCommand = (text) => String(text || '').trim().toLowerCase() === 'cancel';

/**
 * Refusing a request that was addressed to you.
 *
 * A bare word, like confirm and cancel, because it answers a menu that is
 * already open rather than starting anything. Only "decline": "no" is far too
 * common in ordinary chat to promote into a verb that ends a money request.
 */
const isDeclineCommand = (text) => String(text || '').trim().toLowerCase() === 'decline';

/**
 * remind | remind 2 -- nudge the payer of an open request you made.
 *
 * Bare form nudges every open request; the numbered form picks one out of the
 * outgoing menu. Rate limiting is not decided here: this file stays pure, and
 * how often somebody may be nudged is a fact about the request, not the text.
 *
 * @returns {{ index: number|null }|null}
 */
function parseRemindCommand(text) {
  const t = String(text || '').trim();
  if (/^remind$/i.test(t)) return { index: null };
  const m = t.match(/^remind\s+(\d{1,3})$/i);
  if (!m) return null;
  return { index: Number(m[1]) };
}

/**
 * decline 2 -- refuse one row of a numbered incoming menu.
 * @returns {{ index: number }|null} 1-based, as the menu prints it
 */
function parseDeclineCommand(text) {
  const m = String(text || '').trim().match(/^decline\s+(\d{1,3})$/i);
  if (!m) return null;
  return { index: Number(m[1]) };
}

function isOneOf(text, words) {
  return words.includes(String(text || '').trim().toLowerCase());
}

/**
 * Answers to "save them as a trusted contact?", asked right after a first payment.
 *
 * These arrive with no `flizy` prefix on WhatsApp and no slash on Telegram, so the
 * wake check and the normalizer have to accept exactly the same set. While they
 * disagreed the bot woke for a bare "save" and then threw it away: Telegram replied
 * "Not a Flizy command", WhatsApp went silent on its own question. One predicate now,
 * so they cannot drift apart again.
 */
function isMerchantSaveReply(text) {
  const t = String(text || '').trim().toLowerCase();
  return isOneOf(t, ['save', 'yes', 'skip', 'no', 'later']) || t.startsWith('save ');
}

const isHelpCommand = (t) => isOneOf(t, ['help', 'start', 'menu', 'flizy']);
const isBalanceCommand = (t) => isOneOf(t, ['balance', 'bal']);
const isDepositCommand = (t) => isOneOf(t, ['deposit', 'fund', 'topup', 'top up']);
const isHistoryCommand = (t) => isOneOf(t, ['history', 'txs', 'transfers']);
const isMeCommand = (t) => isOneOf(t, ['me', 'whoami', 'account']);
const isPoolCommand = (t) => isOneOf(t, ['pool', 'hotwallet', 'botbalance']);
const isEscrowCommand = (t) => isOneOf(t, ['escrow', 'claims escrow', 'claimescrow']);
const isUsersCommand = (t) => isOneOf(t, ['users', 'listusers']);
const isHowCommand = (t) => isOneOf(t, ['how', 'howto', 'how to']);
const isInviteCommand = (t) => isOneOf(t, ['invite', 'invites', 'share']);
/** List the open offers on NFTs you own and sell into the one picked (lib/nftOffers.js). */
const isAcceptOfferCommand = (t) => isOneOf(t, ['accept offer', 'accept offers']);
const isContactsListCommand = (t) => isOneOf(t, ['contacts', 'list', 'names', 'addressbook']);
const isPhoneShareCommand = (t) => isOneOf(t, ['phone', 'share phone', 'sharephone', 'verify phone']);

/**
 * country | country ghana | country +234 | country clear
 *
 * Sets the optional calling code used when a send has no country code.
 * No argument shows the current one. This is not the answer to the
 * "which country is this number" question. That answer is the name alone.
 *
 * @param {string} text
 * @returns {{ action: 'show' } | { action: 'clear' } | { action: 'set', raw: string } | null}
 */
function parseCountryCommand(text) {
  const match = String(text || '')
    .trim()
    .match(/^country(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  const arg = String(match[1] || '')
    .trim()
    .replace(/\.$/, '');
  if (!arg) return { action: 'show' };
  const lower = arg.toLowerCase();
  if (['clear', 'none', 'off', 'reset', 'remove'].includes(lower)) return { action: 'clear' };
  return { action: 'set', raw: arg };
}

/** unlink | unlink this | unlink whatsapp | unlink telegram */
function parseUnlinkCommand(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t === 'unlink' || t === 'unlink this' || t === 'unlink me' || t === 'unlink flizy') {
    return { scope: 'this' };
  }
  if (t === 'unlink whatsapp' || t === 'unlink wa') {
    return { scope: 'whatsapp' };
  }
  if (t === 'unlink telegram' || t === 'unlink tg') {
    return { scope: 'telegram' };
  }
  return null;
}

/** Command body after any prefix is stripped. */
function isFlizyCommandBody(body) {
  // Canonicalize here too, not only in normalizeInput: this is the gate that
  // decides whether WhatsApp wakes the bot at all, and it runs first. Without
  // it "flizy flz price" is dropped before any parser sees it.
  const t = canonicalizeCommand(String(body || '').trim());
  if (!t) return false;
  return (
    isHelpCommand(t) ||
    isHowCommand(t) ||
    isInviteCommand(t) ||
    isAcceptOfferCommand(t) ||
    isBalanceCommand(t) ||
    isDepositCommand(t) ||
    isHistoryCommand(t) ||
    isMeCommand(t) ||
    isPoolCommand(t) ||
    isEscrowCommand(t) ||
    isUsersCommand(t) ||
    isContactsListCommand(t) ||
    isPhoneShareCommand(t) ||
    isConfirmCommand(t) ||
    isDeclineCommand(t) ||
    Boolean(parseRemindCommand(t)) ||
    Boolean(parseDeclineCommand(t)) ||
    isCancelCommand(t) ||
    Boolean(parseUnlinkCommand(t)) ||
    Boolean(parseCountryCommand(t)) ||
    Boolean(unsupportedCurrencyCommand(t)) ||
    Boolean(parseSendCommand(t)) ||
    Boolean(parseNftSendCommand(t)) ||
    Boolean(parseSendNamedAssetCommand(t)) ||
    Boolean(parseMintCommand(t)) ||
    Boolean(parsePayAskCommand(t)) ||
    Boolean(parseSwapCommand(t)) ||
    Boolean(parseCancelClaimsCommand(t)) ||
    Boolean(parseClaimsListCommand(t)) ||
    Boolean(parseRequestCommand(t)) ||
    Boolean(parseSplitCommand(t)) ||
    Boolean(parseCollectCommand(t)) ||
    parsePotsListCommand(t) ||
    Boolean(parsePotCommand(t)) ||
    Boolean(parsePayPotCommand(t)) ||
    Boolean(parsePayPotNoAmountCommand(t)) ||
    Boolean(parseClosePotCommand(t)) ||
    Boolean(parseRenamePotCommand(t)) ||
    Boolean(parseRequestsCommand(t)) ||
    Boolean(parseCreditCommand(t)) ||
    Boolean(parseClaimAdminCommand(t)) ||
    Boolean(parseSaveContactCommand(t)) ||
    Boolean(parseRemoveContactCommand(t)) ||
    Boolean(parseAddWalletCommand(t)) ||
    Boolean(parseCancelTrustedCommand(t)) ||
    Boolean(parseBarePayCode(t)) ||
    Boolean(parseBareContract(t)) ||
    Boolean(parseLinkCommand(t)) ||
    Boolean(parseUnlockCommand(t)) ||
    parseLockCommand(t)
  );
}

/**
 * A pay code on its own, with nothing else around it.
 *
 * This is the paste-first way to pay a merchant: read the number off the
 * counter, send just that, and Flizy answers with whose account it is before
 * asking for an amount. It is the shape people already know from banks, and it
 * is the only entry to sending that needs no verb at all.
 *
 * Deliberately strict -- three groups of three and nothing else on the line.
 * A bare number that is not exactly a pay code is left alone, so this can never
 * swallow an amount, a phone number, or an order reference someone pasted.
 *
 * @param {string} text
 * @returns {{ code: string }'null} code is normalised, grouping stripped
 */
function parseBarePayCode(text) {
  const t = String(text || '').trim();
  if (!/^[0-9]{3}(?:[ -]?[0-9]{3}){2}$/.test(t)) return null;
  const code = normalizePayCode(t);
  return isPayCodeFormat(code) ? { code } : null;
}

/**
 * A bare amount, optionally with an asset: "0.01", "10 FLZ".
 *
 * Only meaningful as a reply inside a flow that already asked "how much?" --
 * on its own it is just a number and the router ignores it. Kept here because
 * it is pure text parsing and belongs with the rest of it.
 *
 * @param {string} text
 * @returns {{ amountEth: string, asset: string, assetExplicit: boolean }|null}
 */
function parseBareAmount(text) {
  return withNormalizedAmount(parseBareAmountRaw(text), 'amountEth');
}

function parseBareAmountRaw(text) {
  const m = String(text || '')
    .trim()
    .match(/^([0-9,]*\.?[0-9]+)(?:\s+([a-zA-Z][a-zA-Z0-9]{0,9}))?$/);
  if (!m) return null;
  return {
    amountEth: m[1],
    asset: m[2] ? normalizeSendAsset(m[2]) : 'ETH',
    // Same flag parseSendCommand already carries. A named ticker is
    // explicit; a bare number is not.
    assetExplicit: Boolean(m[2]),
  };
}

/**
 * The amount that answers "Pay this request?".
 *
 * The prompt asks for a bare amount (`0.01`). People also type `pay 0.01`
 * and `pay 0.01 eth` because `pay` is the command that opened the prompt.
 * `pay 0.01 for coffee` is a different command and is left alone.
 *
 * One function for both the WhatsApp wake gate and the menu handler, so the
 * two cannot disagree about which replies count.
 *
 * @param {string} text
 * @returns {{ amountEth: string, asset: string, assetExplicit: boolean }|null}
 */
function parsePayRequestAmount(text) {
  const t = String(text || '').trim();
  const direct = parseBareAmount(t);
  if (direct) return direct;
  const m = t.match(/^pay\s+(.+)$/i);
  if (!m) return null;
  return parseBareAmount(m[1]);
}

/**
 * A contract address on its own, with nothing else around it.
 *
 * The paste-first way to look at a token: send the address, get told what it
 * is and whether anything backs it, then decide. Same gesture as pasting a pay
 * code, and deliberately the same shape -- one thing on the line, no verb.
 *
 * This only says the text LOOKS like an address. Whether it is a token, a
 * wallet, or nothing at all is a chain question the router answers with
 * getCode: a pasted wallet address must never open a buy flow.
 *
 * @param {string} text
 * @returns {{ address: string }|null} checksummed
 */
function parseBareContract(text) {
  const t = String(text || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(t)) return null;
  try {
    return { address: ethers.getAddress(t) };
  } catch {
    return null;
  }
}

module.exports = {
  LISTED_SEND_SYMBOLS,
  NAMED_ASSET_SHAPES,
  SEND_PLATFORM_RE,
  firstDuplicateId,
  isBalanceCommand,
  isCancelCommand,
  isConfirmCommand,
  isDeclineCommand,
  parseDeclineCommand,
  parseRemindCommand,
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
  isAcceptOfferCommand,
  isUsersCommand,
  isValidTrustedName,
  normalizePlatformName,
  normalizeSendAsset,
  parseAddWalletCommand,
  parseCancelTrustedCommand,
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
  parsePayRequestAmount,
  parseRemoveContactCommand,
  parseRequestCommand,
  parseClosePotCommand,
  parseCollectCommand,
  parsePayPotCommand,
  parsePayPotNoAmountCommand,
  parsePotCommand,
  parsePotsListCommand,
  parseRenamePotCommand,
  parseSplitCommand,
  parseRequestsCommand,
  parseSaveContactCommand,
  parseSendCommand,
  parseSendNamedAssetCommand,
  parseSwapCommand,
  parseUnlinkCommand,
  parseCountryCommand,
};
