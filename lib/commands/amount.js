/**
 * Amount text: what a person types, turned into something the engine can use.
 *
 * Pure, and deliberately importless -- same rule as the parsers next door. Read
 * no balance, no rate, no account. Everything here is a function of its string.
 *
 * Three jobs, all of them text:
 *
 *   - **Thousands separators.** People type `10,000`. Before this, that did not
 *     parse at all, and an unparsed send is silence on WhatsApp.
 *   - **Currency we cannot settle.** `₦10,000` and `$10` have no rate behind
 *     them and `docs/STAGE-2-PLAN.md` locks "not invent FX". They still deserve
 *     an answer in words rather than nothing.
 *   - **A bare amount that is not plausibly ETH.** `send 10000 to john` is
 *     already refused by the per-send cap, but quoting an ETH cap answers a
 *     question the user was not asking. They were thinking in naira.
 *
 * This file does not decide what to do about any of that. It reports.
 */

/**
 * A well-formed amount, with or without grouping.
 *
 * Grouping must be real grouping: `1,234` and `1,234,567` yes, `1,23` and
 * `1,,2` no. A comma in the wrong place is more likely a typo than a number,
 * and guessing which is not this file's job.
 */
const WELL_FORMED = /^(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]*)(?:\.[0-9]+)?$/;

/**
 * Strip grouping and hand back a plain decimal string, or null if the text is
 * not a well-formed amount.
 *
 * Returns a string rather than a number on purpose: amounts travel to
 * `ethers.parseEther` as strings, and a round trip through a float is exactly
 * how a wei-level rounding bug gets in.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeAmount(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (!WELL_FORMED.test(s)) return null;
  const stripped = s.replace(/,/g, '');
  // `.` and `,` alone both survive the pattern above but are not amounts.
  if (!/[0-9]/.test(stripped)) return null;
  return stripped;
}

/**
 * Currencies a user may type that Flizy cannot settle today.
 *
 * Matched only when the marker is actually attached to a number, so a note
 * mentioning naira in passing is left alone. `N` needs the tighter rule: it is
 * a real Nigerian shorthand (`N5000`) but also a letter, so it only counts
 * glued to digits at a word boundary.
 */
const UNSETTLEABLE = [
  { re: /₦\s*[0-9]/, label: 'Naira' },
  { re: /(?:^|\s)NGN\s*[0-9]/i, label: 'Naira' },
  { re: /(?:^|\s)N[0-9]/, label: 'Naira' },
  { re: /\$\s*[0-9]/, label: 'Dollar' },
  { re: /(?:^|\s)USD\s*[0-9]/i, label: 'Dollar' },
];

/**
 * Name the currency in a text, or null.
 *
 * Exported for its own tests rather than for a caller: production goes through
 * `unsupportedCurrencyCommand`, which adds the verb gate. The table above is
 * the part worth testing without that gate in the way, so this is not dead.
 *
 * @param {string} text
 * @returns {string|null} 'Naira' | 'Dollar'
 */
function detectUnsupportedCurrency(text) {
  const t = String(text || '');
  for (const { re, label } of UNSETTLEABLE) {
    if (re.test(t)) return label;
  }
  return null;
}

/**
 * Is this bare amount too large to have meant ETH?
 *
 * The ceiling is not a safety limit -- `maxSendEth` already refuses anything
 * over the per-send cap. It is the line where the honest diagnosis changes.
 * Below it the cap is what went wrong. At or above it, the user was
 * almost certainly not thinking in ETH at all, and saying so is more use than
 * quoting a cap.
 *
 * @param {unknown} amount already normalized
 * @param {number} ceiling
 * @returns {boolean}
 */
function looksLikeNonEthAmount(amount, ceiling) {
  const n = Number(amount);
  const limit = Number(ceiling);
  if (!Number.isFinite(n) || !Number.isFinite(limit)) return false;
  return n >= limit;
}

/** The verbs that carry an amount. Anything else is not a payment command. */
const AMOUNT_VERB = /^(?:send|pay|transfer|give|request)\b/i;

/**
 * A payment command naming money we cannot price, or null.
 *
 * Verb-scoped on purpose. WhatsApp is a shared inbox and this predicate is
 * one of the things that decides whether the bot wakes at all, so it must
 * not fire on someone mentioning a price in conversation. `send $10 to bob`
 * is a command; "it cost $10" is not.
 *
 * @param {string} text command body, prefix already stripped
 * @returns {string|null} 'Naira' | 'Dollar'
 */
function unsupportedCurrencyCommand(text) {
  const t = String(text || '').trim();
  if (!AMOUNT_VERB.test(t)) return null;
  return detectUnsupportedCurrency(t);
}

module.exports = {
  normalizeAmount,
  detectUnsupportedCurrency,
  unsupportedCurrencyCommand,
  looksLikeNonEthAmount,
};
