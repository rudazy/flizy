'use client';

import { useState } from 'react';
import { useExternalWallet } from './ExternalWalletProvider';
import { TradeWalletSwitch } from './WalletModeBits';
import { DepositSheet } from './DepositSheet';
import { WalletIcon } from './ExploreIcons';
import { shortAddress } from '../lib/walletChain';

/**
 * The visitor's own wallet, inside the Flizy Wallet card on Account, under the
 * Flizy wallet's address. The Flizy wallet stays primary: chat, payments and
 * claims run from it.
 *
 *   - Not connected: one small "Connect external wallet" button.
 *   - Connected: its address with Deposit and Disconnect beside it, and
 *     "Trade from", which picks which wallet signs swaps and NFT trades; the
 *     own wallet signs its own, with no Flizy key involved.
 *   - Deposit opens DepositSheet: ETH or tUSD, a share of the wallet's balance,
 *     one approval in the wallet.
 *   - Back the other way, nothing new: the own wallet becomes a trusted wallet
 *     through the Trusted slide (account password, 24 hour wait), and then
 *     chat sends to it by name, as to any trusted address. The site still
 *     sends nothing out of the Flizy wallet (web/app/api/withdraw/route.ts).
 */
export function OwnWalletPanel({
  flizyAddress,
  trusted,
  onTrust,
  usdPerEth,
}: {
  flizyAddress: string;
  trusted: Array<{ address: string; label: string }>;
  /** Open the Trusted slide with this address filled in. */
  onTrust: (address: string) => void;
  /** For the dollar line in the deposit dialog; null hides it. */
  usdPerEth: number | null;
}) {
  const wallet = useExternalWallet();
  const [depositOpen, setDepositOpen] = useState(false);

  const own = wallet?.address ?? null;
  const trustedEntry = own ? trusted.find((t) => t.address.toLowerCase() === own.toLowerCase()) : undefined;
  const sameAsFlizy = own != null && own.toLowerCase() === flizyAddress.toLowerCase();

  if (!own) {
    return (
      <div className="border-t border-[#26262a] px-3.5 py-2.5">
        <button
          type="button"
          disabled={!wallet}
          onClick={() => void wallet?.connect()}
          className="inline-flex items-center gap-1.5 rounded-[8px] border border-sun/70 px-2.5 py-1 font-sans text-[11.5px] font-semibold text-sun hover:bg-[#1c180c] disabled:opacity-40"
        >
          <WalletIcon size={13} />
          Connect external wallet
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-3 border-t border-[#26262a] px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#3a3017] bg-[#1c180c] text-sun">
          <WalletIcon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 font-mono text-[12px] text-[#f3f1ec]">{shortAddress(own)}</p>
          <p className="m-0 flex items-center gap-1 font-sans text-[11px] text-[#2fd27a]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#2fd27a]" aria-hidden="true" />
            Connected
          </p>
        </div>
        {sameAsFlizy ? null : (
          <button
            type="button"
            className="rounded-[8px] bg-sun px-3.5 py-1.5 font-sans text-[12px] font-semibold text-sun-ink hover:opacity-90"
            onClick={() => setDepositOpen(true)}
          >
            Deposit
          </button>
        )}
        <button type="button" className="font-sans text-[12px] text-[#8d8d8d] hover:text-white" onClick={() => wallet?.disconnect()}>
          Disconnect
        </button>
      </div>

      {sameAsFlizy ? (
        <p className="m-0 font-sans text-[12.5px] text-[#e0b070]">This is your Flizy wallet itself. Connect a different wallet.</p>
      ) : (
        <>
          <TradeWalletSwitch />
          <DepositSheet
            open={depositOpen}
            onClose={() => setDepositOpen(false)}
            flizyAddress={flizyAddress}
            usdPerEth={usdPerEth}
            footer={
              <div className="border-t border-[#26262a] pt-3">
                {trustedEntry ? (
                  <p className="m-0 font-sans text-[12px] leading-relaxed text-[#9a958c]">
                    Trusted as <span className="text-white">{trustedEntry.label}</span>. To move money back, send from chat:{' '}
                    <span className="font-mono text-white">send 0.01 to {trustedEntry.label}</span>
                  </p>
                ) : (
                  <p className="m-0 font-sans text-[12px] leading-relaxed text-[#9a958c]">
                    To move money back to this wallet later,{' '}
                    <button
                      type="button"
                      className="text-sun underline-offset-2 hover:underline"
                      onClick={() => {
                        setDepositOpen(false);
                        onTrust(own);
                      }}
                    >
                      add it as a trusted wallet
                    </button>
                    . That takes your account password and a 24 hour wait, then chat can send to it by name.
                  </p>
                )}
              </div>
            }
          />
        </>
      )}
    </div>
  );
}
