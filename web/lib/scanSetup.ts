import { getDexAddresses } from './dexServer.ts';
import { LISTED_TOKENS } from './listedTokens.ts';
import type { NftContext } from './nftApi.ts';
import type { ScanSetup } from './walletScanRecord.ts';

/** Flizy's fee router, marketplace and tokens as this deployment has them, for guest rows on Scan. */
export function scanSetup(ctx: Pick<NftContext, 'market'>): ScanSetup {
  const dex = getDexAddresses();
  return {
    feeRouter: dex.feeRouter,
    weth: dex.wrappedNative,
    market: ctx.market?.address ?? null,
    tokens: [
      { address: dex.flz, symbol: 'FLZ', decimals: 18 },
      ...LISTED_TOKENS.map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals })),
    ],
  };
}
