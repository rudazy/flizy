/**
 * Spending fence. Savings is base units of one asset the account moved out of
 * Available. Available is the chain balance minus that amount, read each time.
 * It is not a second wallet, a bank balance, or yield.
 *
 * A missing table leaves spends on the existing path. A failed read refuses the
 * spend. The check lives here so a chat reply cannot be the only gate.
 */

const { ethers } = require('ethers');
const { formatAmount } = require('./amountDisplay');
const { listedBySymbol, symbolLabel } = require('./listedTokens');
const { normalizeSendAsset } = require('./commands/parse');

const SPEND_BUCKETS = new Set(['spend', 'spending', 'available']);
const SAVE_BUCKETS = new Set(['savings', 'reserve', 'vault']);
const BUCKET_WORDS = new Set([...SPEND_BUCKETS, ...SAVE_BUCKETS]);

/**
 * @param {bigint|string|number} holding
 * @param {bigint|string|number} reserved
 * @param {bigint|string|number} [gas]
 * @returns {bigint}
 */
function availableBase(holding, reserved, gas = 0n) {
  const left = asBase(holding) - asBase(reserved) - asBase(gas);
  return left > 0n ? left : 0n;
}

/**
 * True when `amount` fits in holding minus reserved minus gas.
 * An amount that lands exactly on the line is allowed. One unit over is not.
 * @returns {boolean}
 */
function covers(holding, reserved, amount, gas = 0n) {
  return asBase(holding) - asBase(reserved) - asBase(gas) >= asBase(amount);
}

function asBase(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('negative base');
    return value;
  }
  const text = String(value ?? '0').trim();
  if (!/^[0-9]+$/.test(text)) throw new Error('bad base');
  return BigInt(text);
}

/**
 * @param {string} raw a send target, with or without @
 * @returns {boolean}
 */
function isReserveTarget(raw) {
  const word = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '');
  return BUCKET_WORDS.has(word);
}

/**
 * @param {string} amount
 * @param {string} asset
 * @param {(body: string) => string} command
 */
function reserveTargetRefusal(amount, asset, command) {
  const label = symbolLabel(normalizeSendAsset(asset || 'ETH'));
  const typed = String(amount || '').trim() || '0';
  return [
    'Savings is not a person.',
    `To move money: ${command(`transfer ${typed} ${label} from spending to savings`)}`,
  ].join('\n');
}

/**
 * @param {string} symbol
 * @param {{ flzToken?: string }|null} [chain]
 * @returns {{ asset: string, decimals: number, token: string|null, label: string }|null}
 */
function resolveReserveAsset(symbol, chain) {
  const key = normalizeSendAsset(symbol || 'ETH');
  if (key === 'ETH') return { asset: 'ETH', decimals: 18, token: null, label: 'ETH' };
  if (key === 'FLZ') {
    const token = chain && chain.flzToken ? String(chain.flzToken) : '';
    if (!token) return null;
    return { asset: 'FLZ', decimals: 18, token, label: 'FLZ' };
  }
  const listed = listedBySymbol(key);
  if (!listed) return null;
  return {
    asset: listed.symbol,
    decimals: listed.decimals,
    token: listed.address,
    label: symbolLabel(listed.symbol),
  };
}

function reserveStoreMissing(error) {
  const code = String(error && error.code ? error.code : '');
  const msg = String(error && error.message ? error.message : error || '');
  if (code === 'PGRST205' || code === 'PGRST202' || code === '42P01' || code === '42883') return true;
  return /account_reserves|move_account_reserve/i.test(msg) && /schema cache|does not exist|could not find/i.test(msg);
}

/**
 * @param {{ from: Function }} supabase
 * @param {string} accountId
 */
async function loadReserveRows(supabase, accountId) {
  const { data, error } = await supabase
    .from('account_reserves')
    .select('asset, amount')
    .eq('account_id', accountId);
  if (error) {
    if (reserveStoreMissing(error)) return { ok: true, missing: true, rows: [] };
    return { ok: false, rows: [] };
  }
  const rows = [];
  for (const row of data || []) {
    const amount = String(row.amount ?? '').trim();
    if (!/^[A-Z][A-Z0-9]{0,15}$/.test(String(row.asset || '')) || !/^[0-9]+$/.test(amount)) {
      return { ok: false, rows: [] };
    }
    rows.push({ asset: String(row.asset), amount });
  }
  return { ok: true, missing: false, rows };
}

/**
 * @param {{ from: Function }} supabase
 * @param {string} accountId
 * @param {string} asset
 * @returns {Promise<{ ok: true, amount: bigint, missing: boolean } | { ok: false }>}
 */
async function reservedOf(supabase, accountId, asset) {
  const loaded = await loadReserveRows(supabase, accountId);
  if (!loaded.ok) return { ok: false };
  const row = loaded.rows.find((item) => item.asset === asset);
  return { ok: true, missing: loaded.missing, amount: row ? BigInt(row.amount) : 0n };
}

function spendRefusal(label, available, decimals) {
  let shown = '0';
  try {
    shown = formatAmount(ethers.formatUnits(available > 0n ? available : 0n, decimals));
  } catch {
    shown = '0';
  }
  return [
    'Insufficient available balance.',
    `Available: ${shown} ${label}`,
    'Savings is not included in available funds.',
  ].join('\n');
}

/**
 * Refuse a spend that fits the chain balance only because it uses Savings.
 * A plain shortfall (the chain balance itself is short) returns ok so the
 * caller's own funding message still speaks. A missing table returns ok.
 *
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
async function assertSpendable(supabase, accountId, { asset, holding, amount, gas = 0n, decimals, label }) {
  let reserved;
  try {
    reserved = await reservedOf(supabase, accountId, asset);
  } catch {
    return { ok: false, message: 'Could not read Savings. Nothing was sent.' };
  }
  if (!reserved.ok) return { ok: false, message: 'Could not read Savings. Nothing was sent.' };
  if (reserved.missing) return { ok: true };
  let fitsReserved;
  let fitsRaw;
  try {
    fitsReserved = covers(holding, reserved.amount, amount, gas);
    fitsRaw = covers(holding, 0n, amount, gas);
  } catch {
    return { ok: false, message: 'Could not read Savings. Nothing was sent.' };
  }
  if (fitsReserved) return { ok: true };
  if (!fitsRaw) return { ok: true };
  return {
    ok: false,
    message: spendRefusal(label || asset, availableBase(holding, reserved.amount, gas), decimals),
  };
}

/**
 * Chain holdings with Savings taken off, for Available displays.
 * An unreadable token row is left as it was.
 * @param {object|null} holdings
 * @param {{ asset: string, amount: string }[]} rows base units
 */
function applyReservesToHoldings(holdings, rows) {
  if (!holdings) return holdings;
  const saved = new Map((rows || []).map((row) => [row.asset, BigInt(row.amount)]));
  const next = { ...holdings };
  if (next.native && next.native.balance != null && next.native.balance !== '') {
    const have = ethers.parseUnits(String(next.native.balance), 18);
    const keep = saved.get('ETH') || 0n;
    const left = have > keep ? have - keep : 0n;
    next.native = { ...next.native, balance: ethers.formatUnits(left, 18) };
  }
  if (Array.isArray(next.tokens)) {
    next.tokens = next.tokens.map((token) => {
      if (token.balance == null || token.balance === '') return token;
      try {
        const decimals = Number.isInteger(token.decimals) ? token.decimals : 18;
        const key = normalizeSendAsset(token.symbol || '');
        const have = ethers.parseUnits(String(token.balance), decimals);
        const keep = saved.get(key) || 0n;
        const left = have > keep ? have - keep : 0n;
        return { ...token, balance: ethers.formatUnits(left, decimals) };
      } catch {
        return token;
      }
    });
  }
  return next;
}

/**
 * @param {{ asset: string, amount: string }[]} rows
 * @param {{ flzToken?: string }|null} chain
 */
function formatSavingsMessage(rows, chain) {
  const lines = ['Savings', ''];
  const held = (rows || []).filter((row) => row.amount !== '0');
  if (!held.length) {
    lines.push('Nothing is in Savings.');
  } else {
    for (const row of held) {
      const info = resolveReserveAsset(row.asset, chain);
      const decimals = info ? info.decimals : 18;
      const label = info ? info.label : row.asset;
      lines.push(`${label}: ${formatAmount(ethers.formatUnits(BigInt(row.amount), decimals))}`);
    }
  }
  lines.push(
    '',
    'Funds here are not available for normal spending.',
    'This is not a bank account and it does not earn yield.',
    '',
    'Move back: {{cmd:transfer 20 from savings to spending}}'
  );
  return lines.join('\n');
}

/**
 * Gas kept in Available when ETH moves into Savings. Token moves and moves
 * back to Spending do not keep gas out of the figure: gas is ETH.
 * @param {string} asset
 * @param {string} direction
 * @param {bigint|string|number} gasBuffer
 * @returns {bigint}
 */
function reserveMoveGas(asset, direction, gasBuffer) {
  if (String(asset || '') === 'ETH' && direction === 'to_savings') return asBase(gasBuffer);
  return 0n;
}

function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return [error.message, error.details, error.hint].filter(Boolean).join(' ');
}

/**
 * Map a move_account_reserve failure onto a sentence. The raw error is not
 * returned: it can carry SQL text.
 * @returns {{ missing: boolean, message: string }}
 */
function mapReserveMoveError(error, { label, holding, reserved, gas = 0n, decimals }) {
  if (reserveStoreMissing(error)) return { missing: true, message: 'Savings is not on yet.' };
  const text = errorText(error);
  if (/insufficient available/i.test(text)) {
    return {
      missing: false,
      message: spendRefusal(label, availableBase(holding, reserved, gas), decimals),
    };
  }
  if (/insufficient savings/i.test(text)) {
    return { missing: false, message: savingsShortfall(label, asBase(reserved), decimals) };
  }
  return { missing: false, message: 'Could not move that. Nothing changed.' };
}

/**
 * Plan-time Available check for a send or a claim hold.
 * A plain shortfall stays ok so assertPlanFunded still speaks.
 * A token plan checks the token and the ETH that pays gas, separately.
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
async function refusePlanSpend(supabase, accountId, plan, funds) {
  if (!accountId || !plan) return { ok: true };
  const isNft = Boolean(plan.route?.nftTokenId) || plan.route?.kind === 'erc721_transfer';
  const isToken =
    !isNft &&
    (plan.route?.kind === 'erc20_transfer' ||
      (plan.route?.kind === 'claim_hold' && Boolean(plan.route?.tokenAddress)));
  let ethHolding;
  let gas;
  try {
    ethHolding = ethers.parseEther(String(funds?.ethBalanceHuman ?? '0'));
    gas = ethers.parseEther(String(funds?.gasBufferEth ?? '0'));
  } catch {
    return { ok: false, message: 'Could not verify wallet balance.' };
  }
  if (isNft) {
    return assertSpendable(supabase, accountId, {
      asset: 'ETH',
      holding: ethHolding,
      amount: 0n,
      gas,
      decimals: 18,
      label: 'ETH',
    });
  }
  if (isToken) {
    const asset = normalizeSendAsset(plan.input?.asset || 'ETH');
    const decimals = Number.isInteger(funds?.tokenDecimals) ? funds.tokenDecimals : 18;
    if (funds?.tokenBalanceHuman == null || funds.tokenBalanceHuman === '') {
      return { ok: false, message: 'Could not verify wallet balance.' };
    }
    let amount;
    let holding;
    try {
      amount = ethers.parseUnits(String(plan.input.amount), decimals);
      holding = ethers.parseUnits(String(funds.tokenBalanceHuman), decimals);
    } catch {
      return { ok: false, message: 'Could not verify wallet balance.' };
    }
    const tokenFence = await assertSpendable(supabase, accountId, {
      asset,
      holding,
      amount,
      gas: 0n,
      decimals,
      label: symbolLabel(asset),
    });
    if (!tokenFence.ok) return tokenFence;
    return assertSpendable(supabase, accountId, {
      asset: 'ETH',
      holding: ethHolding,
      amount: 0n,
      gas,
      decimals: 18,
      label: 'ETH',
    });
  }
  let amount;
  try {
    amount = ethers.parseEther(String(plan.input?.amount ?? '0'));
  } catch {
    return { ok: false, message: 'Could not verify wallet balance.' };
  }
  return assertSpendable(supabase, accountId, {
    asset: 'ETH',
    holding: ethHolding,
    amount,
    gas,
    decimals: 18,
    label: 'ETH',
  });
}

function savingsShortfall(label, reservedBase, decimals) {
  let shown = '0';
  try {
    shown = formatAmount(ethers.formatUnits(reservedBase > 0n ? reservedBase : 0n, decimals));
  } catch {
    shown = '0';
  }
  return ['Insufficient Savings balance.', `Available in Savings: ${shown} ${label}`].join('\n');
}

module.exports = {
  BUCKET_WORDS,
  SAVE_BUCKETS,
  SPEND_BUCKETS,
  applyReservesToHoldings,
  assertSpendable,
  availableBase,
  covers,
  formatSavingsMessage,
  isReserveTarget,
  loadReserveRows,
  mapReserveMoveError,
  refusePlanSpend,
  reserveMoveGas,
  reserveStoreMissing,
  reserveTargetRefusal,
  reservedOf,
  resolveReserveAsset,
  savingsShortfall,
  spendRefusal,
};
