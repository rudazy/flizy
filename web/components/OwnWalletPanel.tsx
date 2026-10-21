'use client';

import { useCallback, useEffect, useState } from 'react';
import { useExternalWallet } from './ExternalWalletProvider';
import { TradeWalletSwitch } from './WalletModeBits';
import { PAY_ASSETS, type PayAsset } from '../lib/payAsset';
import { listedBySymbol, symbolLabel } from '../lib/listedTokens';
import { FLZ_TOKEN, GIWA, giwaClients, shortAddress, walletErrorText } from '../lib/walletChain';
import { walletBalances } from '../lib/walletTrade';

/** ETH kept back on Max, so the deposit itself can still pay its gas. */
const ETH_GAS_RESERVE = 0.0005;

/**
 * The visitor's own wallet, inside the Flizy Wallet card on Account. The Flizy
 * wallet stays primary: chat, payments and claims run from it.
 *
 *   - Trade: "Trade from" picks which wallet signs swaps and NFT trades; the
 *     own wallet signs its own, with no Flizy key involved. Chat sends,
 *     payments and claims stay on the Flizy wallet.
 *   - Deposit: the own wallet sends ETH, tUSD or FLZ to the Flizy wallet in one
 *     signature. Money coming in needs nothing more.
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
  const [balances, setBalances] = useState<Record<PayAsset, string> | null>(null);

  const own = wallet?.address ?? null;
  const trustedEntry = own ? trusted.find((t) => t.address.toLowerCase() === own.toLowerCase()) : undefined;
  const sameAsFlizy = own != null && own.toLowerCase() === flizyAddress.toLowerCase();
  const tusd = listedBySymbol('TUSD');

  const loadBalances = useCallback(async () => {
    if (!own) return;
    try {
      const read = await walletBalances(own, [
        { address: FLZ_TOKEN, decimals: 18 },
        ...(tusd ? [{ address: tusd.address, decimals: tusd.decimals }] : []),
      ]);
      setBalances({
        ETH: read.eth,
        FLZ: read.tokens[FLZ_TOKEN.toLowerCase()] ?? '0',
        TUSD: tusd ? (read.tokens[tusd.address.toLowerCase()] ?? '0') : '0',
      });
    } catch {
      // No balance shown is better than a wrong one; the deposit still works.
      setBalances(null);
    }
  }, [own, tusd]);

  useEffect(() => {
    setBalances(null);
    void loadBalances();
  }, [loadBalances]);

  const balance = balances ? Number(balances[asset]) : null;
  const maxAmount = balance == null ? null : asset === 'ETH' ? Math.max(0, balance - ETH_GAS_RESERVE) : balance;

  function fillMax() {
    if (maxAmount == null || maxAmount <= 0 || !balances) return;
    // Tokens go in full, as read; ETH rounds down so the reserve is kept.
    setAmount(asset === 'ETH' ? (Math.floor(maxAmount * 1e6) / 1e6).toString() : balances[asset]);
  }

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
        const listed = asset === 'TUSD' ? tusd : null;
        const token = (listed ? listed.address : FLZ_TOKEN) as `0x${string}`;
        const units = viem.parseUnits(amount, listed ? listed.decimals : 18);
        hash = await signer.writeContract({ address: token, abi: viem.erc20Abi, functionName: 'transfer', args: [to, units] });
      }
      const receipt = await reader.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The deposit failed on chain.');
      setDone({ url: `${GIWA.explorerUrl}/tx/${hash}`, text: `Deposited ${amount} ${symbolLabel(asset)} into your Flizy wallet.` });
      setAmount('');
      void loadBalances();
    } catch (err) {
      setError(walletErrorText(err, 'The deposit did not go through.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 border-t border-[#26262a] px-3.5 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <p className="m-0 font-sans text-[13px] font-semibold text-white">Connected wallet</p>
        {own ? (
          <span className="flex items-center gap-3">
            <span className="font-mono text-[12px] text-[#f3f1ec]">{shortAddress(own)}</span>
            <button type="button" className="font-sans text-[12px] text-[#8d8d8d] hover:text-white" onClick={() => wallet?.disconnect()}>
              Disconnect
            </button>
          </span>
        ) : null}
      </div>

      {!own ? (
        <>
          <p className="m-0 font-sans text-[12.5px] leading-relaxed text-[#9a958c]">
            Connect MetaMask, Coinbase or any wallet to move money into your Flizy wallet in one step.
          </p>
          <button type="button" className="btn btn-primary w-full py-3" disabled={!wallet} onClick={() => void wallet?.connect()}>
            Connect wallet
          </button>
        </>
      ) : sameAsFlizy ? (
        <p className="m-0 font-sans text-[12.5px] text-[#e0b070]">This is your Flizy wallet itself. Connect a different wallet.</p>
      ) : (
        <>
          <TradeWalletSwitch disabled={busy} />
          <p className="m-0 font-sans text-[12px] text-[#8d867c]">Deposit to your Flizy wallet</p>
          <div className="flex gap-2" role="group" aria-label="Asset to deposit">
            {PAY_ASSETS.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  setAsset(opt);
                  setAmount('');
                }}
                disabled={busy}
                className={asset === opt ? 'btn btn-primary flex-1 py-2' : 'btn btn-ghost flex-1 py-2'}
              >
                {symbolLabel(opt)}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className="input min-w-0 flex-1"
              inputMode="decimal"
              aria-label={`Amount of ${symbolLabel(asset)} to deposit`}
              placeholder={asset === 'ETH' ? '0.01' : asset === 'TUSD' ? '50' : '10'}
              value={amount}
              onChange={(e) => setAmount(e.target.value.trim())}
              disabled={busy}
            />
            <button type="button" className="btn btn-ghost px-4" onClick={fillMax} disabled={busy || maxAmount == null || maxAmount <= 0}>
              Max
            </button>
          </div>
          <p className="m-0 font-sans text-[12px] text-[#8d867c]">
            In this wallet: {balances ? `${Number(balances[asset]).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbolLabel(asset)}` : '...'}
          </p>
          <button type="button" className="btn btn-primary w-full py-3" disabled={busy || !(Number(amount) > 0)} onClick={() => void deposit()}>
            {busy ? 'Confirm in your wallet' : `Deposit ${amount ? `${amount} ` : ''}${symbolLabel(asset)} to Flizy`}
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

          <div className="grid gap-2 border-t border-[#26262a] pt-3">
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
    </div>
  );
}
