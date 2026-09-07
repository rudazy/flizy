/**
 * How an amount is written, everywhere.
 *
 * Chat and the site each grew their own rule and they disagreed in a way that
 * mattered: the site rounded anything at or above 1000 to two decimals, so a
 * transfer of `12345.6789 FLZ` read as `12,345.68` on the dashboard and
 * `12345.6789` in chat. Same row, two numbers, and the shorter one was wrong.
 *
 * The site also grouped thousands and chat did not, and the site grouped using
 * `toLocaleString(undefined, …)` — the *viewer's* locale. In a locale that
 * groups with dots, `12345.6789` renders `12.345,6789`, which in a money app
 * is not a formatting quirk, it is a different number. The grouping locale is
 * pinned here for that reason. `en-US` grouping matches `en-NG`, so it is also
 * the right shape for the market this is aimed at.
 *
 * The rule:
 *
 *   - zero is `0`
 *   - below 0.000001, exponential, because six decimals would show `0`
 *   - otherwise up to six decimals, trailing zeros dropped, thousands grouped
 *
 * Six decimals is a display cap, not a precision claim. The stored value keeps
 * whatever the chain gave it; this only decides what a person reads.
 *
 * **No fiat here, deliberately.** Writing ₦ or $ against a balance needs a
 * rate, and there is no rate source in this codebase. A number invented to
 * fill that gap would sit next to somebody's money looking authoritative, so
 * amounts stay in the asset that settles them until a real one exists.
 *
 * Mirrored by `web/lib/amountDisplay.ts` for client components, which cannot
 * reach into this package. `test/amountDisplay.test.js` pins the two together.
 */

/** Below this a six-decimal rendering would read as plain zero. */
const EXPONENTIAL_BELOW = 0.000001;

/** Display cap. Not a statement about how much precision the value has. */
const MAX_DECIMALS = 6;

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0';
  if (Math.abs(n) < EXPONENTIAL_BELOW) return n.toExponential(4);

  const fixed = n.toFixed(MAX_DECIMALS).replace(/\.?0+$/, '');
  const dot = fixed.indexOf('.');
  const whole = dot === -1 ? fixed : fixed.slice(0, dot);
  const fraction = dot === -1 ? '' : fixed.slice(dot + 1);

  // Pinned locale: grouping must not depend on who is reading.
  const grouped = Number(whole).toLocaleString('en-US');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

module.exports = {
  EXPONENTIAL_BELOW,
  MAX_DECIMALS,
  formatAmount,
};
