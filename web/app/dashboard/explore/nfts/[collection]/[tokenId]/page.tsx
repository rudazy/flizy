import { AppPage } from '../../../../../../components/AppSection';
import { NftItem } from '../../../../../../components/NftItem';

export default function NftItemPage({ params }: { params: { collection: string; tokenId: string } }) {
  const address = /^0x[0-9a-fA-F]{40}$/.test(params.collection || '') ? params.collection : null;
  const tokenId = /^[0-9]{1,78}$/.test(params.tokenId || '') ? params.tokenId : null;
  return (
    <AppPage>
      {address && tokenId ? (
        <NftItem address={address} tokenId={tokenId} />
      ) : (
        <p className="m-0 pt-6 font-sans text-[13px] text-[#a9a9a9]">That is not an NFT address.</p>
      )}
    </AppPage>
  );
}
