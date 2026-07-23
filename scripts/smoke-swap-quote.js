/** Smoke: quote 0.01 ETH -> FLZ on live GIWA. */
require('dotenv').config();
const { ethers } = require('ethers');
const { quoteSwap, getFlzPrice, getDexConfig } = require('../lib/dex');
const { getDefaultChain } = require('../lib/chains');

async function main() {
  const chain = getDefaultChain();
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
  const dex = getDexConfig(chain.id);
  console.log('feeRouter', dex.feeRouter);
  console.log('flz', dex.flz);
  const px = await getFlzPrice(provider, chain.id);
  console.log('price flzPerEth', px.flzPerEth);
  const q = await quoteSwap({
    provider,
    amountIn: ethers.parseEther('0.01'),
    tokenIn: null,
    tokenOut: dex.flz,
    chainKey: chain.id,
  });
  console.log('out FLZ', ethers.formatEther(q.amountOut));
  console.log('fee ETH', ethers.formatEther(q.feeAmount));
  console.log('feeBps', q.feeBps);
  console.log('minOut', ethers.formatEther(q.amountOutMin));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
