import { TokenDetail } from '../../../../../components/TokenDetail';

/** FLZ by name, or any imported token by its contract: one page for both. */
export default function TokenPage({ params }: { params: { symbol: string } }) {
  return <TokenDetail symbol={params.symbol || ''} />;
}
