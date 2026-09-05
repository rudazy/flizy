/**
 * The one funding wall (site half).
 *
 * Deliberate mirror of lib/engine/fundingWall.js -- the web bundle cannot reach
 * into the bot package, so the copy is written twice and pinned by
 * test/fundingWall.test.js, which loads both and compares them on the same
 * vectors. Change one side, change the other, or that test fails.
 *
 * No imports on purpose, so node --test can load this file directly. That is
 * why the origin is resolved here rather than through lib/siteOrigin.ts.
 *
 * Why a wall says more than an address, and why the chat half lives elsewhere:
 * see the header of lib/engine/fundingWall.js.
 */

/** Set as `reason` on any refusal built here. Unused on the site; kept in step. */
export const FUND_REASON = 'insufficient_funds';

function origin(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://flizy.app';
  try {
    return new URL(raw).origin;
  } catch {
    return 'https://flizy.app';
  }
}

/** The one primary fund path. The Fund slide holds address, copy button, steps. */
export function fundUrl(): string {
  return `${origin()}/dashboard/wallet?s=fund`;
}

export type FundingWallArgs = {
  kind: 'gas' | 'native' | 'token';
  address: string;
  asset?: string;
  have?: string | null;
  need?: string | null;
};

/**
 * `have` and `need` are already-formatted amounts without a unit. Only the plan
 * stage has them; the execute paths hold raw wei and omit both.
 */
export function fundingWallText({
  kind,
  address,
  asset = 'ETH',
  have = null,
  need = null,
}: FundingWallArgs): string {
  const lines: string[] = [];

  if (kind === 'gas') {
    lines.push('Need a little ETH in your Flizy wallet for gas.');
  } else if (kind === 'native') {
    lines.push('Not enough ETH in your Flizy wallet (amount + gas).');
    if (have != null && need != null) {
      lines.push(`Have ${have} ETH · Need ~${need} ETH + gas`);
    }
  } else {
    lines.push(`Not enough ${asset} in your Flizy wallet.`);
    if (have != null && need != null) {
      lines.push(`Have ${have} ${asset} · Need ${need} ${asset}`);
    }
  }

  lines.push('', `Your wallet: ${address}`, `Add funds: ${fundUrl()}`);
  return lines.join('\n');
}

/**
 * Not a funding wall: the user does not own the NFT they are trying to move.
 * Adding ETH does not fix that, so this carries no fund route.
 */
export function notHeldText({ line, address }: { line: string; address: string }): string {
  return [`You do not hold ${line}.`, `Your wallet: ${address}`].join('\n');
}
