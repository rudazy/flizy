import Link from 'next/link';
import { AppPage } from '../../../../../../components/AppSection';
import { MintManage } from '../../../../../../components/MintManage';

export default function ManageMintPage({ params }: { params: { collection: string } }) {
  const address = /^0x[0-9a-fA-F]{40}$/.test(params.collection || '') ? params.collection : null;
  return (
    <AppPage>
      <div className="mx-auto grid w-full max-w-lg gap-[14px] pt-[6px]">
        <Link href="/dashboard/explore/nfts/mints" className="hit-y-44 font-sans text-[12.5px] text-[#cfcfcf] no-underline hover:text-white">
          My Mints
        </Link>
        {address ? (
          <MintManage collection={address} />
        ) : (
          <p className="m-0 pt-6 font-sans text-[13px] text-[#a9a9a9]">That is not a collection address.</p>
        )}
      </div>
    </AppPage>
  );
}
