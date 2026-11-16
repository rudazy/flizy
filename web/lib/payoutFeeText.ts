import { centsText, type FeeConfig } from './fees.ts';
import { activeFeeConfig } from './feeQuote.ts';

/**
 * What a platform pays Flizy per payout, in words for the Developers page
 * (the rules are lib/api/payoutFee.js; the platform pays, the recipient never).
 */
export function payoutFeeText(mode: string, feeBps: number, env: Record<string, string | undefined> = process.env): string {
  let cfg: FeeConfig | null;
  try {
    cfg = activeFeeConfig(env);
  } catch {
    cfg = null;
  }
  if (!cfg) return 'None while Flizy fees are off';
  if (mode === 'none') return 'None';
  if (mode === 'bps') return `${(Number(feeBps) / 100).toFixed(2).replace(/\.?0+$/, '')}% of each payout, paid by you`;
  const step = (micro: bigint) => centsText(micro);
  return `${step(cfg.p2pBase)} per payout up to ${step(cfg.p2pStepSize)}, plus ${step(cfg.p2pStep)} per started ${step(cfg.p2pStepSize)}, paid by you`;
}
