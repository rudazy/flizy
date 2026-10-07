import Link from 'next/link';
import { AppPage } from '../../../../../../components/AppSection';
import { MintPanel } from '../../../../../../components/MintPanel';

export default function MintPage({ params }: { params: { collection: string } }) {
  const address = /^0x[0-9a-fA-F]{40}$/.test(params.collection || '') ? params.collection : null;
  return (
    <AppPage>
      <div className="grid w-full gap-[14px] pt-[6px]">
        <div className="flex items-center justify-between gap-[10px]">
          <Link href="/dashboard/explore?s=nfts&nft=mint" className="hit-y-44 font-sans text-[12.5px] text-[#cfcfcf] no-underline hover:text-white">
            Back to Mint
          </Link>
          {address ? (
            <Link href={`/dashboard/explore/nfts/${address}`} className="hit-y-44 font-sans text-[12.5px] text-sun no-underline">
              View collection
            </Link>
          ) : null}
        </div>
        {address ? (
          <MintPanel collection={address} hero />
        ) : (
          <p className="m-0 pt-6 font-sans text-[13px] text-[#a9a9a9]">That is not a collection address.</p>
        )}
      </div>
    </AppPage>
  );
}
