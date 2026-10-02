import { AppPage } from '../../../../../components/AppSection';
import { NftCollection } from '../../../../../components/NftCollection';

export default function CollectionPage({ params }: { params: { collection: string } }) {
  const address = /^0x[0-9a-fA-F]{40}$/.test(params.collection || '') ? params.collection : null;
  return (
    <AppPage>
      {address ? (
        <NftCollection address={address} />
      ) : (
        <p className="m-0 pt-6 font-sans text-[13px] text-[#a9a9a9]">That is not a collection address.</p>
      )}
    </AppPage>
  );
}
