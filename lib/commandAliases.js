/**
 * Deterministic command canonicalizer.
 *
 * Chat is loose ("flz price", "cash out 50 flz", "trade 100 flz"); the parsers
 * in router.js are strict single-shape regexes. This layer rewrites a loose
 * command into the one shape those parsers already accept, so each parser stays
 * one unambiguous pattern instead of growing a tail of alternatives.
 *
 * SAFETY RULE (enforced by test/commandAliases.test.js):
 * a rule may only rewrite verbs, filler words and word order. It must never
 * alter an amount, a 0x address, an email, an @handle or a platform name, and
 * must never invent a recipient that was not typed. Every rule matches the WHOLE
 * command and re-emits amounts, symbols and recipients as verbatim captures, so
 * no token-level substitution can reach inside a send target.
 *
 * The send rules are the sharp ones. Two things keep them safe:
 *   - the "pay 5 to X" form captures everything after the amount as ONE opaque
 *     group, so all fourteen target shapes parseSendCommand understands (email,
 *     phone, 0x, platform:user, "@user on telegram", alias) keep their existing
 *     handling for free -- this layer never learns what a target looks like;
 *   - the "pay X 5" form is the only rule that moves a recipient, and it moves
 *     it as one verbatim capture it never inspects.
 * A send still ends at a confirm preview naming the resolved recipient, so a
 * misread here is visible before any money moves.
 *
 * Anything matching no rule is returned byte-for-byte, so claim / link / unlock
 * commands are untouched by construction rather than by care.
 */

/**
 * A ticker-like word: starts with a letter, stays short.
 *
 * Deliberately cannot match the things that must never be rewritten: a 0x
 * address starts with a digit, an email carries @ and a dot, an @handle carries
 * @, and all three are longer than the cap.
 */
const SYM = '[a-zA-Z][a-zA-Z0-9]{0,11}';

/** A plain decimal amount. Always passed through as a capture, never parsed. */
const AMT = '[0-9]*\\.?[0-9]+';

/** Words that join two sides of a swap: "for", "to", "into". */
const FOR = '(?:for|to|into)';

/** Trailing question mark and spaces, so "flz price?" reads the same as "flz price". */
const END = '\\s*\\??\\s*$';

function re(body) {
  return new RegExp(`^\\s*${body}`, 'i');
}

/**
 * Ordered rewrite rules. First match wins, so the more specific shapes
 * (those naming both sides of a trade) are listed before the bare ones.
 *
 * @type {Array<{ re: RegExp, to: (m: RegExpMatchArray) => string }>}
 */
const RULES = [
  // --- price -------------------------------------------------------------
  // Only FLZ has a price surface today, so a bare "price" is unambiguous.
  { re: re(`price${END}`), to: () => 'price FLZ' },
  { re: re(`price\\s+(?:of|for)\\s+(${SYM})${END}`), to: (m) => `price ${m[1]}` },
  { re: re(`(?:rate|worth|value|quote)\\s+(?:of|for)\\s+(${SYM})${END}`), to: (m) => `price ${m[1]}` },
  { re: re(`(?:rate|quote)\\s+(${SYM})${END}`), to: (m) => `price ${m[1]}` },
  // "flz price", "flz rate", "flz worth"
  { re: re(`(${SYM})\\s+(?:price|rate|worth|value|quote)${END}`), to: (m) => `price ${m[1]}` },
  // "what's flz", "what is the flz price", "how much is flz going for"
  {
    re: re(
      `(?:what(?:'?s|s| is| are)?|how\\s+much\\s+(?:is|are))\\s+(?:the\\s+)?(${SYM})` +
        `(?:\\s+(?:price|rate|worth|value|going\\s+for))?${END}`
    ),
    to: (m) => `price ${m[1]}`,
  },

  // --- buy ---------------------------------------------------------------
  // "buy 0.1 eth worth of flz" -> the explicit spend-this-much shape.
  {
    re: re(`(?:buy|get|purchase)\\s+(${AMT})\\s+(${SYM})\\s+(?:worth\\s+)?of\\s+(${SYM})${END}`),
    to: (m) => `buy ${m[1]} ${m[2]} of ${m[3]}`,
  },
  // "buy flz with 0.1 eth" -> same shape, sides swapped back into order.
  {
    re: re(`(?:buy|get|purchase)\\s+(${SYM})\\s+(?:with|using)\\s+(${AMT})\\s+(${SYM})${END}`),
    to: (m) => `buy ${m[2]} ${m[3]} of ${m[1]}`,
  },
  // "get 100 flz" / "purchase 100 flz" -> canonical buy, amount is the token.
  { re: re(`(?:buy|get|purchase)\\s+(${AMT})\\s+(${SYM})${END}`), to: (m) => `buy ${m[1]} ${m[2]}` },

  // --- sell --------------------------------------------------------------
  // Naming the other side makes it a swap, not a sell-to-ETH.
  {
    re: re(`(?:sell|cash\\s*out|dump)\\s+(${AMT})\\s+(${SYM})\\s+${FOR}\\s+(${SYM})${END}`),
    to: (m) => `swap ${m[1]} ${m[2]} for ${m[3]}`,
  },
  { re: re(`(?:sell|cash\\s*out|dump)\\s+(${AMT})\\s+(${SYM})${END}`), to: (m) => `sell ${m[1]} ${m[2]}` },

  // --- swap / trade ------------------------------------------------------
  {
    re: re(`(?:swap|convert|exchange|trade)\\s+(${AMT})\\s+(${SYM})\\s+${FOR}\\s+(${SYM})${END}`),
    to: (m) => `swap ${m[1]} ${m[2]} for ${m[3]}`,
  },
  // One side only: direction is genuinely unknown, so hand it to the router's
  // trade prompt rather than picking a side on someone's money.
  {
    re: re(`(?:swap|convert|exchange|trade)\\s+(${AMT})\\s+(${SYM})${END}`),
    to: (m) => `trade ${m[1]} ${m[2]}`,
  },

  // --- send --------------------------------------------------------------
  // "pay 5 to <anything>". Everything from the amount onward is one opaque
  // capture handed straight to parseSendCommand, so every target shape it
  // already understands keeps working and this rule never inspects a recipient.
  //
  // Bare "pay", "pay requests" and "pay request" match nothing here and keep
  // their existing meaning: the list of requests waiting on you.
  {
    re: re(`(?:pay|send|transfer|give|wire)\\s+(${AMT}(?:\\s+${SYM})?\\s+to\\s+\\S.*)$`),
    to: (m) => `send ${m[1]}`,
  },
  // "pay john 5" / "pay john 10 flz" — recipient first, the way people talk.
  // The negative lookahead keeps an amount from being read as the recipient, so
  // "pay 5 to john" can never land here. The recipient is moved verbatim and is
  // never inspected: whether it is an alias, an email or a 0x address is
  // parseSendCommand's business, exactly as it is for a typed "send".
  {
    re: re(
      `(?:pay|send|transfer|give|wire)\\s+(?!${AMT}(?:\\s|$))(\\S{1,64})\\s+(${AMT})(?:\\s+(${SYM}))?${END}`
    ),
    to: (m) => `send ${m[2]}${m[3] ? ` ${m[3]}` : ''} to ${m[1]}`,
  },

  // --- trusted wallet ----------------------------------------------------
  // "add wallet 0x..." already parses; this only adds the "save" wording.
  // Note the alias form "add ama 0x..." (save a contact) matches nothing here.
  {
    re: re(`(?:save|add)\\s+wallet\\s+(0x[a-fA-F0-9]{40})${END}`),
    to: (m) => `add ${m[1]}`,
  },
];

/**
 * Rewrite a loose command body into the canonical shape router.js parses.
 *
 * @param {string} body command body, prefix already stripped
 * @returns {string} canonical body, or the input unchanged when no rule matches
 */
function canonicalizeCommand(body) {
  const raw = String(body || '');
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  for (const rule of RULES) {
    const m = trimmed.match(rule.re);
    if (m) return rule.to(m);
  }
  return raw;
}

module.exports = {
  canonicalizeCommand,
};
