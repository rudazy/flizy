'use client';

import { useState } from 'react';
import { useExternalWallet } from './ExternalWalletProvider';
import { CopyButton } from './CopyButton';
import { PREF_CARD } from './AccountPrefs';
import { PAY_ASSETS, type PayAsset } from '../lib/payAsset';
import { listedBySymbol, symbolLabel } from '../lib/listedTokens';
import { FLZ_TOKEN, GIWA, giwaClients, shortAddress, walletErrorText } from '../lib/walletChain';

/**
 * Account → Wallets. The Flizy wallet is the account's wallet: chat, payments
 * and claims run from it. The visitor's own wallet can sit beside it:
 *
 *   - Deposit: the own wallet sends ETH, tUSD or FLZ to the Flizy wallet, signed
 *     in that wallet. Money coming in needs nothing more.
 *   - Back the other way, nothing new: the own wallet becomes a trusted wallet
 *     through the Trusted slide (account password, 24 hour wait), and then
 *     chat sends to it by name, as to any trusted address. The site still
 *     sends nothing out of the Flizy wallet (web/app/api/withdraw/route.ts).
 *
 * Nothing about the own wallet is stored by Flizy until it is saved as trusted.
 */
export function OwnWalletPanel({
  flizyAddress,
  trusted,
  onTrust,
}: {
  flizyAddress: string;
  trusted: Array<{ address: string; label: string }>;
  /** Open the Trusted slide with this address filled in. */
  onTrust: (address: string) => void;
}) {
  const wallet = useExternalWallet();
  const [asset, setAsset] = useState<PayAsset>('ETH');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ url: string; text: string } | null>(null);

  const own = wallet?.address ?? null;
  const trustedEntry = own ? trusted.find((t) => t.address.toLowerCase() === own.toLowerCase()) : undefined;
  const sameAsFlizy = own != null && own.toLowerCase() === flizyAddress.toLowerCase();

  async function deposit() {
    if (!wallet || !own || busy || !(Number(amount) > 0) || !/^0x[0-9a-fA-F]{40}$/.test(flizyAddress)) return;
    setBusy(true);
    setError('');
    setDone(null);
    try {
      const provider = await wallet.provider();
      if (!provider) throw new Error('Connect your wallet again.');
      const { viem, wallet: signer, reader } = await giwaClients(provider, own);
      const to = flizyAddress as `0x${string}`;
      let hash: `0x${string}`;
      if (asset === 'ETH') {
        hash = await signer.sendTransaction({ account: own, chain: signer.chain, to, value: viem.parseEther(amount) });
      } else {
        const listed = asset === 'TUSD' ? listedBySymbol('TUSD') : null;
        const token = (listed ? listed.address : FLZ_TOKEN) as `0x${string}`;
        const units = viem.parseUnits(amount, listed ? listed.decimals : 18);
        hash = await signer.writeContract({ address: token, abi: viem.erc20Abi, functionName: 'transfer', args: [to, units] });
      }
      const receipt = await reader.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The deposit failed on chain.');
      setDone({ url: `${GIWA.explorerUrl}/tx/${hash}`, text: `Deposited ${amount} ${symbolLabel(asset)} into your Flizy wallet.` });
      setAmount('');
    } catch (err) {
      setError(walletErrorText(err, 'The deposit did not go through.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <section className={`${PREF_CARD} grid gap-2 px-5 py-5`}>
        <p className="m-0 font-mono text-[10.5px] uppercase tracking-[0.24em] text-sun">Flizy wallet · primary</p>
        <p className="m-0 break-all font-mono text-[14px] text-white">{flizyAddress || 'Not ready yet'}</p>
        {flizyAddress ? <CopyButton value={flizyAddress} label="Copy address" /> : null}
        <p className="m-0 font-sans text-[12.5px] leading-relaxed text-[#9a958c]">
          Chat, payments, requests and claims run from this wallet. Money leaves it only from chat, to a trusted wallet.
        </p>
      </section>

      <section className={`${PREF_CARD} grid gap-3 px-5 py-5`}>
        <p className="m-0 font-mono text-[10.5px] uppercase tracking-[0.24em] text-[#9a958c]">Your own wallet</p>
        {!own ? (
          <>
            <p className="m-0 font-sans text-[13px] leading-relaxed text-[#d9d4ca]">
              Connect MetaMask, Coinbase or any wallet to move money into your Flizy wallet in one step.
            </p>
            <button type="button" className="btn btn-primary w-full py-3" disabled={!wallet} onClick={() => void wallet?.connect()}>
              Connect wallet
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[14px] text-white">{shortAddress(own)}</span>
              <button type="button" className="font-sans text-[12.5px] text-[#8d8d8d] hover:text-white" onClick={() => wallet?.disconnect()}>
                Disconnect
              </button>
            </div>

            {sameAsFlizy ? (
              <p className="m-0 font-sans text-[12.5px] text-[#e0b070]">This is your Flizy wallet itself. Connect a different wallet.</p>
            ) : (
              <>
                <div className="flex gap-2" role="group" aria-label="Asset to deposit">
                  {PAY_ASSETS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setAsset(opt)}
                      disabled={busy}
                      className={asset === opt ? 'btn btn-primary flex-1 py-2' : 'btn btn-ghost flex-1 py-2'}
                    >
                      {symbolLabel(opt)}
                    </button>
                  ))}
                </div>
                <input
                  className="input"
                  inputMode="decimal"
                  aria-label={`Amount of ${symbolLabel(asset)} to deposit`}
                  placeholder={asset === 'ETH' ? '0.01' : asset === 'TUSD' ? '50' : '10'}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.trim())}
                  disabled={busy}
                />
                <button type="button" className="btn btn-primary w-full py-3" disabled={busy || !(Number(amount) > 0)} onClick={() => void deposit()}>
                  {busy ? 'Confirm in your wallet' : `Deposit ${amount || ''} ${symbolLabel(asset)} to Flizy`}
                </button>
                {error ? (
                  <p className="m-0 font-sans text-[12.5px] text-[#e0b070]" role="alert">
                    {error}
                  </p>
                ) : null}
                {done ? (
                  <p className="m-0 font-sans text-[12.5px] text-[#2fd27a]">
                    {done.text}{' '}
                    <a href={done.url} target="_blank" rel="noreferrer noopener" className="text-sun no-underline">
                      View on explorer
                    </a>
                  </p>
                ) : null}

                <div className="mt-1 grid gap-2 border-t border-[#26262a] pt-3">
                  {trustedEntry ? (
                    <p className="m-0 font-sans text-[12.5px] leading-relaxed text-[#d9d4ca]">
                      Trusted as <span className="text-white">{trustedEntry.label}</span>. To move money back, send from chat:{' '}
                      <span className="font-mono text-white">send 0.01 to {trustedEntry.label}</span>
                    </p>
                  ) : (
                    <>
                      <p className="m-0 font-sans text-[12.5px] leading-relaxed text-[#9a958c]">
                        To move money back to this wallet, save it as a trusted wallet. That takes your account password and a 24
                        hour wait, then chat can send to it by name.
                      </p>
                      <button type="button" className="btn btn-ghost w-full py-2" onClick={() => onTrust(own)}>
                        Add as trusted wallet
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
