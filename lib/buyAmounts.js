/**
 * The quick buy amounts offered when a token contract is pasted in chat.
 *
 * Each account keeps up to five ETH amounts (accounts.buy_amounts_eth; null
 * means DEFAULT_BUY_AMOUNTS). Telegram shows them as buttons with Edit and
 * Cancel; WhatsApp, which has no buttons here, lists them as text. Typing any
 * amount works on both, and every pick still goes to the swap preview and its
 * confirm: a button never buys on its own.
 *
 * A button carries its amount and the last 8 hex characters of the token it
 * was made for (buy:<amount>:<tag>, or buy:edit:<tag>), so a button left on an
 * older message cannot buy a token pasted since.
 */

const { ethers } = require('ethers');

const DEFAULT_BUY_AMOUNTS = Object.freeze(['0.005', '0.01', '0.05', '0.1', '1']);
const MAX_BUY_AMOUNTS = 5;
/** The most one quick amount may be, in ETH. A typed amount is not limited here. */
const MAX_BUY_AMOUNT_ETH = '100';
/** At most 3 whole digits and 6 decimals: what a button and the column check allow. */
const AMOUNT_RE = /^\d{1,3}(\.\d{1,6})?$/;
const BUTTON_RE = /^buy:(edit|\d{1,3}(?:\.\d{1,6})?):([0-9a-f]{8})$/;

/** The token tag a button carries: the address's last 8 hex characters, lower case. */
function buyTag(address) {
  return String(address).toLowerCase().slice(-8);
}

/** "0.050" -> "0.05", "1.0" -> "1". */
function tidy(amount) {
  const text = ethers.formatEther(ethers.parseEther(amount));
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

/**
 * Read a list of quick amounts: 1 to 5 ETH amounts, separated by spaces or
 * commas, each above 0 and at most 100. Duplicates are dropped and the list
 * sorted.
 * @returns {{ ok: true, amounts: string[] } | { ok: false, message: string }}
 */
function parseBuyAmounts(text) {
  const parts = String(text || '')
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    // "0.01 0.05 eth" reads as amounts with a trailing unit.
    .map((p) => p.replace(/^eth$/i, ''))
    .filter(Boolean)
    // ".5" is 0.5.
    .map((p) => (p.startsWith('.') ? `0${p}` : p));
  if (!parts.length) return { ok: false, message: 'Send at least one amount, for example 0.01.' };
  if (parts.length > MAX_BUY_AMOUNTS) return { ok: false, message: `Send at most ${MAX_BUY_AMOUNTS} amounts.` };
  const max = ethers.parseEther(MAX_BUY_AMOUNT_ETH);
  const seen = new Map();
  for (const part of parts) {
    if (!AMOUNT_RE.test(part)) {
      return { ok: false, message: `"${part.slice(0, 20)}" is not an amount. Use numbers like 0.01, with up to 6 decimals.` };
    }
    const wei = ethers.parseEther(part);
    if (wei === 0n) return { ok: false, message: 'Each amount has to be more than 0.' };
    if (wei > max) return { ok: false, message: `Each amount can be at most ${MAX_BUY_AMOUNT_ETH} ETH.` };
    seen.set(wei, tidy(part));
  }
  const amounts = [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, s]) => s);
  return { ok: true, amounts };
}

/**
 * An account's quick amounts. Anything unreadable or malformed in the row is
 * the defaults, so a bad value can never reach a button. Never throws.
 */
async function readBuyAmounts(supabase, accountId, log = console) {
  if (!accountId) return [...DEFAULT_BUY_AMOUNTS];
  try {
    const { data, error } = await supabase.from('accounts').select('buy_amounts_eth').eq('id', accountId).maybeSingle();
    if (error) throw new Error(error.message);
    const stored = data && data.buy_amounts_eth;
    if (!Array.isArray(stored) || !stored.length) return [...DEFAULT_BUY_AMOUNTS];
    const parsed = parseBuyAmounts(stored.join(' '));
    return parsed.ok ? parsed.amounts : [...DEFAULT_BUY_AMOUNTS];
  } catch (err) {
    log.warn(`[buy-amounts] read failed, using the defaults: ${String(err && err.message).slice(0, 120)}`);
    return [...DEFAULT_BUY_AMOUNTS];
  }
}

/** Save an account's quick amounts; null goes back to the defaults. Returns whether it was saved. Never throws. */
async function saveBuyAmounts(supabase, accountId, amounts, log = console) {
  if (!accountId) return false;
  try {
    const { data, error } = await supabase
      .from('accounts')
      .update({ buy_amounts_eth: amounts ? [...amounts] : null })
      .eq('id', accountId)
      .select('id');
    if (error) throw new Error(error.message);
    return Boolean(data && data.length);
  } catch (err) {
    log.warn(`[buy-amounts] save failed: ${String(err && err.message).slice(0, 120)}`);
    return false;
  }
}

/** A pressed buy button: { action: 'edit' } or { action: 'amount', amount }, with its tag; null when it is not one. */
function parseBuyButton(text) {
  const m = BUTTON_RE.exec(String(text || '').trim().toLowerCase());
  if (!m) return null;
  return m[1] === 'edit' ? { action: 'edit', tag: m[2] } : { action: 'amount', amount: tidy(m[1]), tag: m[2] };
}

/** Whether Telegram may pass this callback data on (lib/telegram/bot.js). */
function isBuyButton(data) {
  return BUTTON_RE.test(String(data || ''));
}

/**
 * The question under a pasted token: text for both channels, and for
 * Telegram the buttons (amounts in rows of three with Edit, then Cancel).
 * @param {{ symbol: string, address: string, amounts: string[], telegram: boolean }} p
 * @returns {{ lines: string[], buttons?: Array<Array<{ label: string, value: string }>> }}
 */
function buyPrompt({ symbol, address, amounts, telegram }) {
  if (!telegram) {
    return {
      lines: [
        `Buy ${symbol} with ETH. Reply with an amount:`,
        amounts.join(' | '),
        'Or type your own. To change these: edit',
        'Or: cancel',
      ],
    };
  }
  const tag = buyTag(address);
  const keys = amounts.map((a) => ({ label: `${a} ETH`, value: `buy:${a}:${tag}` }));
  keys.push({ label: 'Edit', value: `buy:edit:${tag}` });
  const buttons = [];
  for (let i = 0; i < keys.length; i += 3) buttons.push(keys.slice(i, i + 3));
  buttons.push([{ label: 'Cancel', value: 'cancel' }]);
  return { lines: [`Buy ${symbol} with ETH.`, 'Tap an amount, or type your own.'], buttons };
}

/** The question asked after Edit. */
function editPrompt() {
  return [
    `Send up to ${MAX_BUY_AMOUNTS} amounts in ETH, separated by spaces.`,
    'Example: 0.01 0.02 0.05 0.1 0.5',
    'To go back to the defaults: reset',
    'Or: cancel',
  ];
}

module.exports = {
  DEFAULT_BUY_AMOUNTS,
  MAX_BUY_AMOUNTS,
  MAX_BUY_AMOUNT_ETH,
  buyTag,
  parseBuyAmounts,
  readBuyAmounts,
  saveBuyAmounts,
  parseBuyButton,
  isBuyButton,
  buyPrompt,
  editPrompt,
};
