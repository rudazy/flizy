import { HeldToken } from '../../../../../components/HeldToken';
import { TokenDetail } from '../../../../../components/TokenDetail';

export default function TokenPage({ params }: { params: { symbol: string } }) {
  const symbol = params.symbol || '';
  if (/^0x[0-9a-fA-F]{40}$/.test(symbol)) {
    return <HeldToken address={symbol} />;
  }
  return <TokenDetail symbol={symbol} />;
}
