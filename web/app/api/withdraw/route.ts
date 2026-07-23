import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { verifyPassword } from '../../../lib/cryptoPin';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Prefer web self-contained chain; fall back to parent if present
const { getWebChain, getDexAddresses, resolveToken } = require('../../../lib/dexServer');

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

function deriveAgentWallet(accountId: string) {
  const material = ethers.keccak256(ethers.toUtf8Bytes(`flizy:agent:v1:${accountId}`));
  return new ethers.Wallet(material);
}

/**
 * Emergency site withdraw from agent wallet.
 * Requires account password. Destination is free-form (user may lack WhatsApp).
 */
export async function POST(req: Request) {
  try {
    const accountId = getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json();
    const password = String(body.password || '');
    const toRaw = String(body.to || '').trim();
    const amountRaw = String(body.amount || '').trim();
    const asset = String(body.asset || 'ETH').trim().toUpperCase();

    if (!password) {
      return NextResponse.json({ error: 'Password required' }, { status: 400 });
    }
    if (!ethers.isAddress(toRaw)) {
      return NextResponse.json({ error: 'Invalid destination address' }, { status: 400 });
    }
    const to = ethers.getAddress(toRaw);

    const supabase = getSupabase();
    const { data: account, error: aErr } = await supabase
      .from('accounts')
      .select('id, password_hash, agent_wallet_address')
      .eq('id', accountId)
      .single();
    if (aErr || !account?.password_hash) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    if (!verifyPassword(password, account.password_hash)) {
      return NextResponse.json({ error: 'Wrong password' }, { status: 403 });
    }

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    const signer = deriveAgentWallet(accountId).connect(provider);

    if (asset === 'ETH' || asset === 'NATIVE') {
      let amountWei: bigint;
      try {
        amountWei = ethers.parseEther(amountRaw);
      } catch {
        return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
      }
      if (amountWei <= 0n) {
        return NextResponse.json({ error: 'Amount must be greater than 0' }, { status: 400 });
      }
      const bal = await provider.getBalance(signer.address);
      // leave a little for gas
      const gasBuffer = ethers.parseEther('0.00005');
      if (bal < amountWei + gasBuffer) {
        return NextResponse.json(
          {
            error: `Not enough ETH (need amount + gas). Balance ~${ethers.formatEther(bal)}`,
          },
          { status: 400 }
        );
      }
      const tx = await signer.sendTransaction({ to, value: amountWei });
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) {
        return NextResponse.json({ error: 'Transaction failed' }, { status: 500 });
      }
      await supabase.from('transfers').insert({
        account_id: accountId,
        to_address: to,
        amount_eth: amountRaw,
        status: 'confirmed',
        tx_hash: tx.hash,
        chain_id: chain.chainId,
        kind: 'withdraw',
      });
      return NextResponse.json({
        ok: true,
        txHash: tx.hash,
        explorerUrl: `${chain.explorerBaseUrl}/tx/${tx.hash}`,
        asset: 'ETH',
        amount: amountRaw,
        to,
      });
    }

    // ERC-20 (e.g. FLZ)
    let tokenAddress: string;
    try {
      const resolved = resolveToken(asset);
      if (!resolved) {
        return NextResponse.json({ error: 'Use ETH or a known token symbol (e.g. FLZ)' }, { status: 400 });
      }
      tokenAddress = resolved;
    } catch {
      if (ethers.isAddress(asset)) tokenAddress = ethers.getAddress(asset);
      else return NextResponse.json({ error: 'Unknown token' }, { status: 400 });
    }

    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const decimals = Number(await token.decimals());
    let amountTok: bigint;
    try {
      amountTok = ethers.parseUnits(amountRaw, decimals);
    } catch {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }
    if (amountTok <= 0n) {
      return NextResponse.json({ error: 'Amount must be greater than 0' }, { status: 400 });
    }
    const tokBal: bigint = await token.balanceOf(signer.address);
    if (tokBal < amountTok) {
      return NextResponse.json({ error: 'Insufficient token balance' }, { status: 400 });
    }
    const ethBal = await provider.getBalance(signer.address);
    if (ethBal < ethers.parseEther('0.00005')) {
      return NextResponse.json(
        { error: 'Need a little ETH in the agent wallet for gas' },
        { status: 400 }
      );
    }

    const tx = await token.transfer(to, amountTok);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      return NextResponse.json({ error: 'Token transfer failed' }, { status: 500 });
    }

    await supabase.from('transfers').insert({
      account_id: accountId,
      to_address: to,
      amount_eth: amountRaw,
      status: 'confirmed',
      tx_hash: tx.hash,
      chain_id: chain.chainId,
      kind: 'withdraw_token',
    });

    const dex = getDexAddresses();
    const symbol = tokenAddress === dex.flz ? 'FLZ' : asset;

    return NextResponse.json({
      ok: true,
      txHash: tx.hash,
      explorerUrl: `${chain.explorerBaseUrl}/tx/${tx.hash}`,
      asset: symbol,
      amount: amountRaw,
      to,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Withdraw failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
