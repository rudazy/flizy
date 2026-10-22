import { ImageResponse } from 'next/og';
import { loadReceipt } from '../../../../lib/receipts.ts';
import { getWebChain } from '../../../../lib/dexServer';
import { partyNote, receiptAmount, receiptHash, receiptUsd, receiptWhen } from '../../../../lib/receiptView';

/**
 * /r/{token}/image: the receipt as a picture, for Share image and Download on
 * the receipt page. It carries what the page already shows to whoever holds
 * the link, names included, so it is opened by the same token and nothing else.
 * The link-preview card (../opengraph-image.tsx) stays name-free.
 */

const SIZE = { width: 1080, height: 1440 };
const GOLD = '#f7d047';
const MUTED = '#a8a29a';

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  let r = null;
  try {
    r = await loadReceipt(params.token, getWebChain().name);
  } catch {
    r = null;
  }
  if (!r) return new Response('Not found', { status: 404, headers: { 'X-Robots-Tag': 'noindex' } });

  const amount = receiptAmount(r.amount);
  // No live rate here: an ETH dollar figure frozen into a saved image would go stale.
  const usd = receiptUsd(r.amount, r.unit, null);
  const rows: Array<[string, string, string | null]> = [
    ['From', r.from, partyNote(r.fromKind, 'from')],
    ['To', r.to, partyNote(r.toKind, 'to')],
    ['Amount', `${amount} ${r.unit}`, usd],
    ...(r.note ? ([['For', r.note, null]] as Array<[string, string, string | null]>) : []),
    ['Network', r.network, null],
    ['Date & time', receiptWhen(r.at), null],
    ...(r.txHash ? ([['Transaction hash', receiptHash(r.txHash), null]] as Array<[string, string, string | null]>) : []),
  ];

  const image = new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', padding: 56, background: '#0d0c0b', fontFamily: 'sans-serif' }}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            padding: '48px 56px',
            borderRadius: 28,
            border: '2px solid #4a3c1a',
            backgroundColor: '#0f0e0c',
            backgroundImage: 'radial-gradient(circle at 50% 0%, #1d1708 0%, #110f0b 55%, #0f0e0c 100%)',
            color: '#ffffff',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div
                style={{
                  display: 'flex',
                  width: 76,
                  height: 76,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 12,
                  border: '2px solid #3a3017',
                  background: '#0a0908',
                  color: GOLD,
                  fontSize: 44,
                  fontWeight: 700,
                }}
              >
                F
              </div>
              <div style={{ display: 'flex', marginLeft: 26, fontSize: 30, letterSpacing: 10, fontWeight: 600 }}>FLIZY</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', fontSize: 22 }}>
              <div style={{ display: 'flex', color: GOLD }}>Payment Receipt</div>
              <div style={{ display: 'flex', color: MUTED, marginTop: 4 }}>Verified on blockchain</div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 36 }}>
            <div
              style={{
                display: 'flex',
                width: 140,
                height: 140,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 70,
                border: `5px solid ${GOLD}`,
                boxShadow: '0 0 60px rgba(247,208,71,0.25)',
              }}
            >
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke={GOLD} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </div>
            <div style={{ display: 'flex', marginTop: 28, fontSize: 52, fontWeight: 700 }}>Payment Successful</div>
            <div style={{ display: 'flex', marginTop: 10, fontSize: 30, color: MUTED }}>Amount sent</div>
            <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 8, fontWeight: 700 }}>
              <span style={{ fontSize: 110 }}>{amount}</span>
              <span style={{ fontSize: 92, color: GOLD, marginLeft: 22 }}>{r.unit}</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 36, borderTop: '2px solid #24211d' }}>
            {rows.map(([label, value, sub]) => (
              <div
                key={label}
                style={{ display: 'flex', alignItems: 'center', padding: '20px 4px', borderBottom: '2px solid #24211d', fontSize: 28 }}
              >
                <div style={{ display: 'flex', width: 360, color: MUTED }}>{label}</div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex' }}>{value}</div>
                  {sub ? <div style={{ display: 'flex', fontSize: 24, color: '#9a958c', marginTop: 4 }}>{sub}</div> : null}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', marginTop: 'auto', fontSize: 22, color: MUTED }}>
            {r.network} is a test network; these funds have no cash value.
          </div>
        </div>
      </div>
    ),
    SIZE
  );
  image.headers.set('X-Robots-Tag', 'noindex');
  // Drawing the image is the costly part; a repeat fetch within five minutes is
  // served from cache. Short, so a name hidden on Scan leaves the image soon after.
  image.headers.set('Cache-Control', 'public, max-age=300, s-maxage=300');
  return image;
}
