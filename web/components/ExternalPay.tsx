'use client';

import { useEffect, useState } from 'react';
import { PAYMENT_RECEIVER, PAYMENT_RECEIVER_CHAIN } from '../lib/paymentReceiver';
import { useExternalWallet } from './ExternalWalletProvider';
import { giwaClients, walletErrorText } from '../lib/walletChain';
import { listedBySymbol, symbolLabel } from '../lib/listedTokens';
import { PAY_ASSETS, type PayAsset } from '../lib/payAsset';

/**
 * Pay a Flizy account from a wallet outside Flizy, connected through the
 * site's one wallet connector (components/ExternalWalletProvider.tsx):
 * WalletConnect, a browser extension, or a wallet app's own browser. No keys
 * or sessions pass through Flizy.
 *
 * The payment goes through FlizyPaymentReceiver, which hands the money straight
 * to the payee. The page then asks the server to read the result from the
 * chain; it is the chain, not this page, that the server believes.
 *
 * viem is loaded only when a payment starts, so the pay page stays light for
 * the payers who never use this.
 */

const RECEIVER_ABI = [
  {
    type: 'function',
    name: 'payNative',
    stateMutability: 'payable',
    inputs: [
      { name: 'invoiceId', type: 'bytes32' },
      { name: 'payee', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'payToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'invoiceId', type: 'bytes32' },
      { name: 'token', type: 'address' },
      { name: 'payee', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/** FLZ is not a listed token, so its contract comes with the payee lookup. */
type Payee = { payee: `0x${string}`; flz: `0x${string}` | null };

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function ExternalPay({
  refSlug,
  presetAmount,
  presetAsset,
  note,
  handle,
}: {
  refSlug: string;
  /** From the link. With one, the amount is fixed; without, the payer types it. */
  presetAmount: string | null;
  presetAsset: PayAsset;
  note: string | null;
  handle: string;
}) {
  const [amount, setAmount] = useState(presetAmount ?? '');
  const [asset, setAsset] = useState<PayAsset>(presetAsset);
  const [step, setStep] = useState<'idle' | 'connecting' | 'approving' | 'paying' | 'checking' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [explorer, setExplorer] = useState('');
  const unit = symbolLabel(asset);
  const wallet = useExternalWallet();
  // Privy can always offer WalletConnect; the browser fallback needs a wallet in this browser.
  const [browserWallet, setBrowserWallet] = useState(false);
  useEffect(() => setBrowserWallet(Boolean((window as unknown as { ethereum?: unknown }).ethereum)), []);
  const canPay = wallet != null && (wallet.via === 'privy' || browserWallet);

  async function confirm(txHash: string, nonce: string) {
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch('/api/pay/external', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: refSlug, txHash, note, nonce }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not check the payment.');
      setExplorer(typeof body.explorerUrl === 'string' ? body.explorerUrl : '');
      return;
    }
    throw new Error('The payment was sent. It is taking a while to confirm; it will show for them once it lands.');
  }

  async function pay() {
    if (!wallet || !canPay || !(Number(amount) > 0)) return;
    setMsg('');
    try {
      setStep('connecting');
      const lookup = await fetch(`/api/pay/external?ref=${encodeURIComponent(refSlug)}`);
      const info = (await lookup.json().catch(() => ({}))) as Partial<Payee> & { error?: string };
      if (!lookup.ok || !info.payee) throw new Error(info.error || 'Could not find who to pay.');
      const account = wallet.address ?? (await wallet.connect());
      if (!account) throw new Error('No wallet was connected.');
      const provider = await wallet.provider();
      if (!provider) throw new Error('Connect your wallet again.');

      const [{ wallet: signer, reader, viem }, { invoiceIdFor }] = await Promise.all([
        giwaClients(provider, account),
        import('../lib/invoiceId'),
      ]);
      const { erc20Abi, parseUnits } = viem;
      const nonce = randomNonce();
      const invoiceId = invoiceIdFor(note, nonce);
      const receiver = PAYMENT_RECEIVER as `0x${string}`;

      let txHash: `0x${string}`;
      if (asset === 'ETH') {
        setStep('paying');
        txHash = await signer.writeContract({
          address: receiver,
          abi: RECEIVER_ABI,
          functionName: 'payNative',
          args: [invoiceId, info.payee],
          value: parseUnits(amount, 18),
        });
      } else {
        const listed = asset === 'TUSD' ? listedBySymbol('TUSD') : null;
        const token = (listed ? listed.address : info.flz) as `0x${string}` | null;
        if (!token) throw new Error(`${unit} cannot be paid from an outside wallet yet.`);
        const units = parseUnits(amount, listed ? listed.decimals : 18);
        const allowed = await reader.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, receiver] });
        if (allowed < units) {
          // Approves this one amount only, never an open-ended allowance.
          setStep('approving');
          const approval = await signer.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [receiver, units] });
          await reader.waitForTransactionReceipt({ hash: approval });
        }
        setStep('paying');
        txHash = await signer.writeContract({
          address: receiver,
          abi: RECEIVER_ABI,
          functionName: 'payToken',
          args: [invoiceId, token, info.payee, units],
        });
      }

      setStep('checking');
      await confirm(txHash, nonce);
      setStep('done');
    } catch (err) {
      setMsg(walletErrorText(err, 'Could not pay.'));
      setStep('error');
    }
  }

  if (step === 'done') {
    return (
      <div className="card space-y-3 p-6">
        <div className="alert alert-ok text-sm">
          Paid {amount} {unit} to {handle}.
        </div>
        {explorer ? (
          <a href={explorer} target="_blank" rel="noreferrer noopener" className="text-sm text-sun no-underline hover:opacity-80">
            View on explorer
          </a>
        ) : null}
      </div>
    );
  }

  const busy = step === 'connecting' || step === 'approving' || step === 'paying' || step === 'checking';
  const label = {
    idle: `Pay ${amount || ''} ${unit} from another wallet`,
    connecting: 'Connecting your wallet',
    approving: `Approve ${unit} in your wallet`,
    paying: 'Confirm in your wallet',
    checking: 'Checking the payment',
    error: `Pay ${amount || ''} ${unit} from another wallet`,
  }[step];

  return (
    <div className="card space-y-3 p-6">
      <p className="m-0 text-xs uppercase tracking-[0.18em] text-muted">No Flizy account?</p>
      {canPay && !presetAmount ? (
        <div className="grid gap-2">
          <div className="flex gap-2" role="group" aria-label="Asset">
            {PAY_ASSETS.map((opt) => (
              <button
                key={opt}
                type="button"
                className={asset === opt ? 'btn btn-primary flex-1 py-2' : 'btn btn-ghost flex-1 py-2'}
                onClick={() => setAsset(opt)}
                disabled={busy}
              >
                {symbolLabel(opt)}
              </button>
            ))}
          </div>
          <input
            className="input"
            inputMode="decimal"
            aria-label={`Amount in ${unit}`}
            placeholder={asset === 'TUSD' ? '20' : asset === 'FLZ' ? '10' : '0.01'}
            value={amount}
            onChange={(e) => setAmount(e.target.value.trim())}
            disabled={busy}
          />
        </div>
      ) : null}
      {canPay ? (
        <>
          <button type="button" className="btn btn-ghost w-full py-3" disabled={busy || !(Number(amount) > 0)} onClick={() => void pay()}>
            {label}
          </button>
          <p className="m-0 text-xs text-muted">
            Pays on {PAYMENT_RECEIVER_CHAIN.name} straight to {handle}. Your wallet shows the exact amount before you sign.
            {asset !== 'ETH' ? ` A token payment asks you to approve ${amount || 'the amount'} ${unit} first.` : ''}
          </p>
        </>
      ) : (
        <p className="m-0 text-sm text-muted">
          To pay from your own wallet, open this link in your wallet app&apos;s browser, or on a computer with a wallet extension.
        </p>
      )}
      {msg ? (
        <div className="alert alert-error text-sm" role="alert">
          {msg}
        </div>
      ) : null}
    </div>
  );
}
