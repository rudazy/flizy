'use client';

import { useEffect, useState } from 'react';
import { PAYMENT_RECEIVER, PAYMENT_RECEIVER_ABI, PAYMENT_RECEIVER_CHAIN } from '../lib/paymentReceiver';
import { useExternalWallet } from './ExternalWalletProvider';
import { giwaClients, walletErrorText } from '../lib/walletChain';

/**
 * Pay a Flizy Pay API checkout from any wallet, through the site's one wallet
 * connector (components/ExternalWalletProvider.tsx). The amount, asset and
 * invoice id are the checkout's, never typed. The payment goes through
 * FlizyPaymentReceiver straight to the platform's wallet; the page then hands
 * the transaction to the server, which believes only the receipt
 * (web/lib/checkout.ts), and follows the checkout until it settles. Closing
 * the page loses nothing: Flizy also finds the payment in the chain's logs.
 */

type Props = {
  id: string;
  amount: string;
  assetLabel: string;
  asset: 'ETH' | 'FLZ' | 'TUSD';
  decimals: number;
  payee: `0x${string}`;
  invoiceId: `0x${string}`;
  token: `0x${string}` | null;
  platformName: string;
};

type Status = { state: string; received: string; overpaid: boolean };

export function CheckoutPay(p: Props) {
  const [step, setStep] = useState<'idle' | 'connecting' | 'approving' | 'paying' | 'checking' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState<Status | null>(null);
  const wallet = useExternalWallet();
  const [browserWallet, setBrowserWallet] = useState(false);
  useEffect(() => setBrowserWallet(Boolean((window as unknown as { ethereum?: unknown }).ethereum)), []);
  const canPay = wallet != null && (wallet.via === 'privy' || browserWallet);

  async function follow(txHash: string): Promise<Status> {
    for (let i = 0; i < 40; i += 1) {
      const res = await fetch(`/api/checkout/${p.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Status> & { error?: string };
      if (res.status === 202) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (!res.ok) throw new Error(body.error || 'Could not check the payment.');
      return { state: String(body.state || ''), received: String(body.received || ''), overpaid: body.overpaid === true };
    }
    throw new Error('The payment was sent and is taking a while to confirm. It will settle once it lands; you can close this page.');
  }

  async function pay() {
    if (!wallet || !canPay) return;
    setMsg('');
    try {
      setStep('connecting');
      const account = wallet.address ?? (await wallet.connect());
      if (!account) throw new Error('No wallet was connected.');
      const provider = await wallet.provider();
      if (!provider) throw new Error('Connect your wallet again.');
      const { wallet: signer, reader, viem } = await giwaClients(provider, account);
      const units = viem.parseUnits(p.amount, p.decimals);
      const receiver = PAYMENT_RECEIVER as `0x${string}`;

      let txHash: `0x${string}`;
      if (p.asset === 'ETH') {
        setStep('paying');
        txHash = await signer.writeContract({ address: receiver, abi: PAYMENT_RECEIVER_ABI, functionName: 'payNative', args: [p.invoiceId, p.payee], value: units });
      } else {
        if (!p.token) throw new Error(`${p.assetLabel} cannot be paid from this wallet.`);
        const allowed = await reader.readContract({ address: p.token, abi: viem.erc20Abi, functionName: 'allowance', args: [account, receiver] });
        if (allowed < units) {
          // Approves this one amount only, never an open-ended allowance.
          setStep('approving');
          const approval = await signer.writeContract({ address: p.token, abi: viem.erc20Abi, functionName: 'approve', args: [receiver, units] });
          await reader.waitForTransactionReceipt({ hash: approval });
        }
        setStep('paying');
        txHash = await signer.writeContract({ address: receiver, abi: PAYMENT_RECEIVER_ABI, functionName: 'payToken', args: [p.invoiceId, p.token, p.payee, units] });
      }
      setStep('checking');
      setDone(await follow(txHash));
    } catch (err) {
      setMsg(walletErrorText(err, 'Could not pay.'));
      setStep('error');
    }
  }

  if (done) {
    const settled = done.state === 'confirmed';
    return (
      <div className={settled ? 'alert alert-ok text-sm' : 'alert text-sm'}>
        {settled
          ? `Paid ${p.amount} ${p.assetLabel} to ${p.platformName}.`
          : `Received ${done.received} ${p.assetLabel} of ${p.amount}. The rest is still to pay.`}
      </div>
    );
  }

  const busy = step === 'connecting' || step === 'approving' || step === 'paying' || step === 'checking';
  const label = {
    idle: `Pay ${p.amount} ${p.assetLabel}`,
    connecting: 'Connecting your wallet',
    approving: `Approve ${p.assetLabel} in your wallet`,
    paying: 'Confirm in your wallet',
    checking: 'Checking the payment',
    error: `Pay ${p.amount} ${p.assetLabel}`,
  }[step];

  return (
    <div className="space-y-3">
      {canPay ? (
        <>
          <button type="button" className="btn btn-primary w-full py-3" disabled={busy} onClick={() => void pay()}>
            {label}
          </button>
          <p className="m-0 text-xs text-muted">
            Pays on {PAYMENT_RECEIVER_CHAIN.name} straight to {p.platformName}. Your wallet shows the exact amount before you sign.
            {p.asset !== 'ETH' ? ` A token payment asks you to approve ${p.amount} ${p.assetLabel} first.` : ''}
          </p>
        </>
      ) : (
        <p className="m-0 text-sm text-muted">Open this page in your wallet app&apos;s browser, or on a computer with a wallet extension, to pay.</p>
      )}
      {msg ? (
        <div className="alert alert-error text-sm" role="alert">
          {msg}
        </div>
      ) : null}
    </div>
  );
}
