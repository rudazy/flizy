/**
 * Chat side of Savings. A move is a book entry on the one wallet, confirmed
 * like a send, and it takes the same account lock a spend takes before the
 * row changes. This module reads the database, so unit tests do not import it.
 */

const { ethers } = require('ethers');
const { config } = require('./config');
const { chain, supabase, provider } = require('./runtime');
const { pendingSends } = require('./commands/pending');
const { requireLinkedSite } = require('./commands/account');
const { reply, cmd, confirmButtons } = require('./commands/chat');
const { tryAccountTxLock, releaseAccountTxLock } = require('./accountTxLock');
const { ensureAgentWallet } = require('./agentWallet');
const { planGasBufferEth } = require('./gatorExecute');
const { formatAmount } = require('./amountDisplay');
const {
  formatSavingsMessage,
  loadReserveRows,
  mapReserveMoveError,
  reserveMoveGas,
  resolveReserveAsset,
} = require('./reserves');

const PENDING_TTL_MS = config.pendingTtlMs;
const pendingMoves = new Map();

function prunePendingMoves() {
  const now = Date.now();
  for (const [key, pending] of pendingMoves.entries()) {
    if (now - pending.createdAt > PENDING_TTL_MS) pendingMoves.delete(key);
  }
}

function hasPendingMove(key) {
  return pendingMoves.has(key);
}

function clearPendingMove(key) {
  pendingMoves.delete(key);
}

function moveErrorClass(error) {
  const text = error && typeof error === 'object'
    ? [error.message, error.details, error.hint].filter(Boolean).join(' ')
    : String(error || '');
  if (/insufficient available/i.test(text)) return 'insufficient available';
  if (/insufficient savings/i.test(text)) return 'insufficient savings';
  if (/bad reserve move/i.test(text)) return 'bad input';
  if (/account_reserves|move_account_reserve/i.test(text) && /schema cache|does not exist|could not find/i.test(text)) {
    return 'missing';
  }
  return 'move failed';
}

function parseMoveBase(amount, decimals) {
  const text = String(amount ?? '').trim();
  if (text.length > 80) return null;
  let base;
  try {
    base = ethers.parseUnits(text, decimals);
  } catch {
    return null;
  }
  if (base <= 0n) return 0n;
  if (base.toString().length > 40) return null;
  return base;
}

async function beginReserveMove(ctx, account, move) {
  if (!move) return;
  if (move.same) {
    await reply(ctx, 'That move stays in the same place.');
    return;
  }
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;
  const info = resolveReserveAsset(move.asset, chain);
  if (!info) {
    await reply(ctx, 'That asset cannot be moved.');
    return;
  }
  const base = parseMoveBase(move.amount, info.decimals);
  if (base === 0n) {
    await reply(ctx, 'Name an amount greater than zero.');
    return;
  }
  if (base == null) {
    await reply(ctx, 'That amount cannot be moved.');
    return;
  }
  const loaded = await loadReserveRows(supabase, siteAcc.id);
  if (!loaded.ok) {
    await reply(ctx, 'Could not read Savings. Nothing was sent.');
    return;
  }
  if (loaded.missing) {
    await reply(ctx, 'Savings is not on yet.');
    return;
  }
  pendingSends.delete(ctx.key);
  pendingMoves.set(ctx.key, {
    accountId: siteAcc.id,
    amount: move.amount,
    asset: info.asset,
    direction: move.direction,
    createdAt: Date.now(),
  });
  const shown = formatAmount(ethers.formatUnits(base, info.decimals));
  const toSavings = move.direction === 'to_savings';
  const mins = Math.max(1, Math.round(PENDING_TTL_MS / 60000));
  await reply(
    ctx,
    [
      `Move ${shown} ${info.label} from ${toSavings ? 'Spending' : 'Savings'} to ${toSavings ? 'Savings' : 'Spending'}.`,
      '',
      `Reply confirm within ${mins} minutes to move it.`,
      'Or: cancel',
    ].join('\n'),
    { buttons: confirmButtons() }
  );
}

async function readHolding(wallet, info) {
  if (info.asset === 'ETH' || !info.token) return provider.getBalance(wallet);
  const erc20 = new ethers.Contract(
    info.token,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );
  return erc20.balanceOf(wallet);
}

async function confirmReserveMove(ctx, account) {
  prunePendingMoves();
  const pending = pendingMoves.get(ctx.key);
  if (!pending) return;

  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    pendingMoves.delete(ctx.key);
    await reply(ctx, 'That move expired. Nothing was moved.');
    return;
  }

  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) {
    pendingMoves.delete(ctx.key);
    return;
  }
  if (String(siteAcc.id) !== String(pending.accountId)) {
    pendingMoves.delete(ctx.key);
    await reply(ctx, 'This chat is no longer on the account that started that move. Nothing was moved.');
    return;
  }

  const info = resolveReserveAsset(pending.asset, chain);
  if (!info && pending.direction === 'to_savings') {
    pendingMoves.delete(ctx.key);
    await reply(ctx, 'That asset cannot be moved.');
    return;
  }
  const decimals = info ? info.decimals : 18;
  const label = info ? info.label : pending.asset;
  const base = parseMoveBase(pending.amount, decimals);
  if (base == null || base === 0n) {
    pendingMoves.delete(ctx.key);
    await reply(ctx, 'That amount cannot be moved.');
    return;
  }

  const lock = await tryAccountTxLock(supabase, siteAcc.id, 'reserve');
  if (!lock.ok) {
    await reply(ctx, lock.error);
    return;
  }
  pendingMoves.delete(ctx.key);

  try {
    const acc = await ensureAgentWallet(siteAcc.id);
    const wallet = ethers.getAddress(acc.agent_wallet_address);
    const holding = info
      ? await readHolding(wallet, info)
      : 0n;
    const gasBuffer = ethers.parseEther(await planGasBufferEth(provider, siteAcc.id, wallet));
    const gas = reserveMoveGas(pending.asset, pending.direction, gasBuffer);
    const booked = await loadReserveRows(supabase, siteAcc.id);
    if (!booked.ok) {
      await reply(ctx, 'Could not read Savings. Nothing was sent.');
      return;
    }
    if (booked.missing) {
      await reply(ctx, 'Savings is not on yet.');
      return;
    }
    const reserved = booked.rows.find((row) => row.asset === pending.asset);
    const reservedBase = reserved ? BigInt(reserved.amount) : 0n;
    const { data, error } = await supabase.rpc('move_account_reserve', {
      p_account_id: siteAcc.id,
      p_asset: pending.asset,
      p_amount: base.toString(),
      p_direction: pending.direction,
      p_holding: holding.toString(),
      p_gas: gas.toString(),
    });
    if (error) {
      console.error('reserve move:', moveErrorClass(error));
      const mapped = mapReserveMoveError(error, {
        label,
        holding,
        reserved: reservedBase,
        gas,
        decimals,
      });
      await reply(ctx, mapped.message);
      return;
    }
    const next = String(data ?? '').trim();
    if (!/^[0-9]+$/.test(next)) {
      console.error('reserve move: bad result');
      await reply(ctx, 'Could not move that. Nothing changed.');
      return;
    }
    const left = holding > BigInt(next) ? holding - BigInt(next) : 0n;
    const shown = formatAmount(ethers.formatUnits(base, decimals));
    const where = pending.direction === 'to_savings' ? 'Savings' : 'Spending';
    await reply(
      ctx,
      [
        `${shown} ${label} moved to ${where}`,
        `Available balance: ${formatAmount(ethers.formatUnits(left, decimals))} ${label}`,
      ].join('\n')
    );
  } catch (err) {
    console.error('reserve move:', moveErrorClass(err));
    await reply(ctx, 'Could not move that. Nothing changed.');
  } finally {
    await releaseAccountTxLock(supabase, siteAcc.id);
  }
}

async function handleSavings(ctx, account) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;
  const loaded = await loadReserveRows(supabase, siteAcc.id);
  if (!loaded.ok) {
    await reply(ctx, 'Could not read Savings right now.');
    return;
  }
  if (loaded.missing) {
    await reply(ctx, 'Savings is not on yet.');
    return;
  }
  await reply(ctx, formatSavingsMessage(loaded.rows, chain));
}

module.exports = {
  beginReserveMove,
  clearPendingMove,
  confirmReserveMove,
  handleSavings,
  hasPendingMove,
  prunePendingMoves,
};
