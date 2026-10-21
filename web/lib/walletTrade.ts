import type { EIP1193Provider } from 'viem';
import { giwaClients } from './walletChain';
import { GIWA } from './walletChain';

/**
 * Trades the visitor's own wallet signs in wallet mode. Browser only.
 *
 * NFT trades: the server plans with the same checks a Flizy-wallet trade runs
 * (POST /api/market/[action]?plan=1), the wallet sends each call in order, and
 * the hash goes back so the Flizy accounts it touched hear about it
 * (POST /api/market/notice). Swaps: built here against the fee router from a
 * server quote, so the fee and the slippage limit are the same as on the site.
 */

type PlannedCall = { to: string; value: string; data: string };

/** Send planned calls one after another, each waiting for its receipt. Returns the last hash. */
async function sendCalls(provider: EIP1193Provider, account: `0x${string}`, calls: PlannedCall[]): Promise<string> {
  if (!calls.length) throw new Error('Nothing to send.');
  const { wallet, reader } = await giwaClients(provider, account);
  let last = '';
  for (const call of calls) {
    const hash = await wallet.sendTransaction({
      account,
      chain: wallet.chain,
      to: call.to as `0x${string}`,
      data: call.data as `0x${string}`,
      value: BigInt(call.value),
    });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('The transaction failed on chain. Nothing more was sent.');
    last = hash;
  }
  return last;
}

/** Plan a marketplace action for this wallet, sign it, and announce it. */
export async function walletMarketTrade(
  provider: EIP1193Provider,
  account: `0x${string}`,
  action: string,
  body: Record<string, unknown>
): Promise<{ txHash: string; explorerUrl: string; label: string }> {
  const res = await fetch(`/api/market/${encodeURIComponent(action)}?plan=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, wallet: account }),
  });
  const plan = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(plan.calls)) throw new Error(typeof plan.error === 'string' ? plan.error : 'That did not go through.');
  const txHash = await sendCalls(provider, account, plan.calls as PlannedCall[]);
  // Best effort: the trade is done whether or not the notice goes out.
  fetch('/api/market/notice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash }),
  }).catch(() => undefined);
  return { txHash, explorerUrl: `${GIWA.explorerUrl}/tx/${txHash}`, label: String(plan.label || 'Done') };
}

/** The parts of a quote from GET /api/swap/quote that a wallet-mode swap needs. */
export type WalletSwapQuote = {
  feeRouter: string;
  path: string[];
  amountInUnits: string;
  amountOutMinUnits: string;
};

const FEE_ROUTER_ABI = [
  {
    type: 'function',
    name: 'swapExactETHForTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'swapExactTokensForETH',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const;

/**
 * Swap with the visitor's own wallet through the fee router, from a server
 * quote: the same router, fee and minimum out the site uses. ETH in when the
 * route starts at WETH, otherwise the token is approved for this amount only
 * (never an open-ended allowance) and swapped for ETH. The output goes to the
 * wallet that signed.
 */
export async function walletSwap(
  provider: EIP1193Provider,
  account: `0x${string}`,
  quote: WalletSwapQuote,
  weth: string
): Promise<{ txHash: string; explorerUrl: string }> {
  const { viem, wallet, reader } = await giwaClients(provider, account);
  const router = quote.feeRouter as `0x${string}`;
  const path = quote.path.map((a) => a as `0x${string}`);
  const amountIn = BigInt(quote.amountInUnits);
  const minOut = BigInt(quote.amountOutMinUnits);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  let hash: `0x${string}`;
  if (path[0].toLowerCase() === weth.toLowerCase()) {
    hash = await wallet.writeContract({
      address: router,
      abi: FEE_ROUTER_ABI,
      functionName: 'swapExactETHForTokens',
      args: [minOut, path, account, deadline],
      value: amountIn,
    });
  } else {
    const allowed = await reader.readContract({ address: path[0], abi: viem.erc20Abi, functionName: 'allowance', args: [account, router] });
    if (allowed < amountIn) {
      const approval = await wallet.writeContract({ address: path[0], abi: viem.erc20Abi, functionName: 'approve', args: [router, amountIn] });
      await reader.waitForTransactionReceipt({ hash: approval });
    }
    hash = await wallet.writeContract({
      address: router,
      abi: FEE_ROUTER_ABI,
      functionName: 'swapExactTokensForETH',
      args: [amountIn, minOut, path, account, deadline],
    });
  }
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('The swap failed on chain.');
  return { txHash: hash, explorerUrl: `${GIWA.explorerUrl}/tx/${hash}` };
}

/** ETH and token balances of the connected wallet, read from the chain. */
export async function walletBalances(
  account: `0x${string}`,
  tokens: Array<{ address: string; decimals: number }>
): Promise<{ eth: string; tokens: Record<string, string> }> {
  const viem = await import('viem');
  const reader = viem.createPublicClient({ transport: viem.http(GIWA.rpcUrl) });
  const eth = viem.formatEther(await reader.getBalance({ address: account }));
  const out: Record<string, string> = {};
  await Promise.all(
    tokens.map(async (t) => {
      try {
        const raw = await reader.readContract({ address: t.address as `0x${string}`, abi: viem.erc20Abi, functionName: 'balanceOf', args: [account] });
        out[t.address.toLowerCase()] = viem.formatUnits(raw, t.decimals);
      } catch {
        // A token that cannot be read shows no balance rather than a wrong one.
      }
    })
  );
  return { eth, tokens: out };
}

