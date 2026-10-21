import { ImageResponse } from 'next/og';
import { loadReceipt } from '../../../lib/receipts.ts';
import { getWebChain } from '../../../lib/dexServer';

/**
 * The card a chat app draws when a receipt link is pasted: the amount, large,
 * and nothing about who paid whom. Names stay on the page, behind the click.
 */

export const alt = 'Payment receipt on Flizy';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image({ params }: { params: { token: string } }) {
  // A link that opens no receipt says so plainly; "confirmed" is said only of a real payment.
  let kicker = 'RECEIPT';
  let line = 'Flizy receipt';
  let network = 'Flizy';
  try {
    const r = await loadReceipt(params.token, getWebChain().name);
    if (r) {
      kicker = 'PAYMENT CONFIRMED';
      line = `${r.amount} ${r.unit}`;
      network = r.network;
    }
  } catch {
    // A card without the amount is still a card; the page says the rest.
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 72,
          background: '#0a0a0a',
          color: '#f5f5f5',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', fontSize: 34, letterSpacing: 8, color: '#f7d047' }}>FLIZY</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 30, color: '#9a958c', letterSpacing: 4 }}>{kicker}</div>
          <div style={{ display: 'flex', fontSize: 120, fontWeight: 700, marginTop: 12 }}>{line}</div>
        </div>
        <div style={{ display: 'flex', fontSize: 28, color: '#666666' }}>{network}</div>
      </div>
    ),
    size
  );
}
