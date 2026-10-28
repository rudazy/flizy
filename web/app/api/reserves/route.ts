import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../lib/requestOrigin';
import { apiErrorBody } from '../../../lib/apiError';
import { tryAccountTxLock, releaseAccountTxLock } from '../../../lib/accountTxLock';
import { gatorGasReserveWei, pointerIsGator } from '../../../lib/gatorExecute';
import { getWebChain } from '../../../lib/dexServer';
import { formatAmount } from '../../../lib/amountDisplay';
import { parseUnits, formatUnits, reserveMoveGas } from '../../../lib/reservesMath';
import {
  SAVINGS_HELPER,
  loadReserveRows,
  mapReserveMoveError,
  reserveStoreMissing,
  resolveReserveAsset,
} from '../../../lib/reserveStore';

const ROUTE = 'POST /api/reserves';

const ERC20_BALANCE = ['function balanceOf(address) view returns (uint256)'];

function moveErrorClass(error: { message?: string; details?: string; hint?: string } | null): string {
  const text = error ? [error.message, error.details, error.hint].filter(Boolean).join(' ') : '';
  if (/insufficient available/i.test(text)) return 'insufficient available';
  if (/insufficient savings/i.test(text)) return 'insufficient savings';
  if (/bad reserve move/i.test(text)) return 'bad input';
  if (reserveStoreMissing(error)) return 'missing';
  return 'move failed';
}

function gasBufferWei(): bigint {
  try {
    return ethers.parseEther(String(process.env.GAS_BUFFER_ETH || '0.0001'));
  } catch {
    return ethers.parseEther('0.0001');
  }
}

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const supabase = getSupabase();
    const loaded = await loadReserveRows(supabase, accountId);
    if (!loaded.ok) return NextResponse.json({ error: 'Could not read Savings.' }, { status: 503 });
    if (loaded.missing) return NextResponse.json({ ok: true, missing: true, rows: [] });
    const rows = loaded.rows.map((row) => {
      const info = resolveReserveAsset(row.asset);
      const decimals = info ? info.decimals : 18;
      const label = info ? info.label : row.asset;
      let amount = '0';
      try {
        amount = formatUnits(BigInt(row.amount), decimals);
      } catch {
        amount = '0';
      }
      return { asset: row.asset, label, amount, amountBase: row.amount, decimals };
    });
    return NextResponse.json({ ok: true, missing: false, rows, helper: SAVINGS_HELPER });
  } catch (err) {
    return NextResponse.json(apiErrorBody('GET /api/reserves', err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const direction = body.direction === 'to_savings' || body.direction === 'to_spending' ? body.direction : '';
    if (!direction) return NextResponse.json({ error: 'That move stays in the same place.' }, { status: 400 });

    const info = resolveReserveAsset(String(body.asset || ''));
    if (!info && direction === 'to_savings') {
      return NextResponse.json({ error: 'That asset cannot be moved.' }, { status: 400 });
    }
    const asset = info ? info.asset : String(body.asset || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,15}$/.test(asset)) {
      return NextResponse.json({ error: 'That asset cannot be moved.' }, { status: 400 });
    }
    const decimals = info ? info.decimals : 18;
    const label = info ? info.label : asset;
    const typed = String(body.amount ?? '').trim().replace(/,/g, '');
    if (typed.length > 80) return NextResponse.json({ error: 'That amount cannot be moved.' }, { status: 400 });
    let base: bigint;
    try {
      base = parseUnits(typed, decimals);
    } catch {
      return NextResponse.json({ error: 'That amount cannot be moved.' }, { status: 400 });
    }
    if (base <= 0n) return NextResponse.json({ error: 'Name an amount greater than zero.' }, { status: 400 });
    if (base.toString().length > 40) return NextResponse.json({ error: 'That amount cannot be moved.' }, { status: 400 });

    const supabase = getSupabase();
    const lock = await tryAccountTxLock(supabase, accountId, 'reserve');
    if (!lock.ok) return NextResponse.json({ error: lock.error }, { status: 409 });

    try {
      const { data: account } = await supabase
        .from('accounts')
        .select('agent_wallet_address')
        .eq('id', accountId)
        .maybeSingle();
      const stored = account?.agent_wallet_address;
      if (!stored || !ethers.isAddress(stored)) {
        return NextResponse.json({ error: 'Could not move that. Nothing changed.' }, { status: 400 });
      }
      const wallet = ethers.getAddress(stored);
      const chain = getWebChain();
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
      let holding = 0n;
      if (info) {
        holding = info.token
          ? await new ethers.Contract(info.token, ERC20_BALANCE, provider).balanceOf(wallet)
          : await provider.getBalance(wallet);
      }
      const viaGator = pointerIsGator(accountId, stored);
      const gasBuf = viaGator ? await gatorGasReserveWei(provider, wallet) : gasBufferWei();
      const gas = reserveMoveGas(asset, direction, gasBuf);
      const booked = await loadReserveRows(supabase, accountId);
      if (!booked.ok) return NextResponse.json({ error: 'Could not read Savings. Nothing was sent.' }, { status: 503 });
      if (booked.missing) return NextResponse.json({ error: 'Savings is not available yet.' }, { status: 503 });
      const reserved = booked.rows.find((row) => row.asset === asset);
      const reservedBase = reserved ? BigInt(reserved.amount) : 0n;
      const { data, error } = await supabase.rpc('move_account_reserve', {
        p_account_id: accountId,
        p_asset: asset,
        p_amount: base.toString(),
        p_direction: direction,
        p_holding: holding.toString(),
        p_gas: gas.toString(),
      });
      if (error) {
        console.error('reserve move:', moveErrorClass(error));
        const mapped = mapReserveMoveError(error, { label, holding, reserved: reservedBase, gas, decimals });
        const status = mapped.missing ? 503 : 400;
        const message = mapped.missing ? 'Savings is not available yet.' : mapped.message;
        return NextResponse.json({ error: message }, { status });
      }
      const next = String(data ?? '').trim();
      if (!/^[0-9]+$/.test(next)) {
        console.error('reserve move: bad result');
        return NextResponse.json({ error: 'Could not move that. Nothing changed.' }, { status: 400 });
      }
      const left = holding > BigInt(next) ? holding - BigInt(next) : 0n;
      return NextResponse.json({
        ok: true,
        asset,
        label,
        direction,
        amount: formatAmount(formatUnits(base, decimals)),
        available: formatAmount(formatUnits(left, decimals)),
      });
    } finally {
      await releaseAccountTxLock(supabase, accountId);
    }
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
