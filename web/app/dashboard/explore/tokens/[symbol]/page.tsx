import { TokenDetail } from '../../../../../components/TokenDetail';

/** FLZ by name, or any imported token by its contract: one page for both. */
export default async function TokenPage({ params: paramsIn }: { params: Promise<{ symbol: string }> }) {
  const params = await paramsIn;
  return <TokenDetail symbol={params.symbol || ''} />;
}
