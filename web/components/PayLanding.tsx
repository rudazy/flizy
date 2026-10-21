'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PinField, pinReady } from './PinField';
import { txPin } from '../lib/txPin';
import { withinQuickSend } from '../lib/quickSend';
import { PAY_ASSETS, type PayAsset } from '../lib/payAsset';
import { symbolLabel } from '../lib/listedTokens';
import type { PayPreset } from '../lib/payLink';
import { ShareReceiptButton } from './ShareReceiptButton';
import { ExternalPay } from './ExternalPay';

/** A sensible example amount per asset, shown as the input placeholder. */
const PLACEHOLDER: Record<PayAsset, string> = { ETH: '0.01', FLZ: '10', TUSD: '20' };

export function PayLanding({
  refSlug,
  username,
  displayName,
  preset = null,
  outsidePay = false,
}: {
  refSlug: string;
  username: string | null;
  displayName: string | null;
  /** From the link: a suggested amount, asset and note. The payer still reviews and confirms. */
  preset?: PayPreset | null;
  /** The owner lets wallets outside Flizy pay this link (accounts.accept_outside_pay). */
  outsidePay?: boolean;
}) {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [self, setSelf] = useState(false);
  const [payerHandle, setPayerHandle] = useState('');
  const [amount, setAmount] = useState(preset?.amount ?? '');
  const [asset, setAsset] = useState<PayAsset>(preset?.asset ?? 'ETH');
  /** Already flattened and capped by parsePayPreset; the server cleans it again. */
  const note = preset?.note ?? null;
  const unit = symbolLabel(asset);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const [explorer, setExplorer] = useState('');
  const [transferId, setTransferId] = useState('');
  const [firstPay, setFirstPay] = useState(false);
  const [alreadySaved, setAlreadySaved] = useState(true);
  /** From the preview: paid before, and the most a payment may be without the PIN. */
  const [known, setKnown] = useState(false);
  const [quickSendEth, setQuickSendEth] = useState('0');
  /** The server asked for the PIN on a payment the page thought was quick. */
  const [pinAsked, setPinAsked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSkipped, setSaveSkipped] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [savePassword, setSavePassword] = useState('');
  /** Enter the amount, then review it, then pay. Nothing moves before Confirm. */
  const [stage, setStage] = useState<'edit' | 'review'>('edit');

  const handle = username ? `@${username}` : 'this Flizy account';
  // Sign-in returns to the same ask, not to an empty form.
  const presetQuery = new URLSearchParams({
    ...(preset?.amount ? { amount: preset.amount } : {}),
    ...(preset && preset.asset !== 'ETH' ? { asset: preset.asset.toLowerCase() } : {}),
    ...(note ? { for: note } : {}),
  }).toString();
  const next = `/pay/${encodeURIComponent(refSlug)}${presetQuery ? `?${presetQuery}` : ''}`;
  const amountOk = Number(amount) > 0;
  /** Pay a token amount with ETH (POST /api/pay/swap). Off until the payer asks for it. */
  const [withEth, setWithEth] = useState(false);
  const [ethQuote, setEthQuote] = useState<{ maxEth: string } | null>(null);
  // With the transaction PIN off (web/lib/txPin.ts) no payment asks for it.
  // With it on, paying with ETH always does, and so does anything past quick send.
  const needsPin =
    txPin.required && (withEth || pinAsked || !(asset === 'ETH' && known && withinQuickSend(amount, quickSendEth)));

  async function quoteWithEth() {
    setMsg('');
    setEthQuote(null);
    try {
      const res = await fetch(`/api/pay/swap?asset=${asset}&amount=${encodeURIComponent(amount)}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.maxEth !== 'string') {
        setMsg(typeof body.error === 'string' ? body.error : 'Could not price this in ETH.');
        setWithEth(false);
        return;
      }
      setEthQuote({ maxEth: body.maxEth });
      setWithEth(true);
    } catch {
      setMsg('Could not price this in ETH.');
      setWithEth(false);
    }
  }

  useEffect(() => {
    let live = true;
    // The preview alone says signed in or not, own page or not, and first
    // payment or not, so the form and its warning wait on nothing else.
    fetch(`/api/pay/preview?ref=${encodeURIComponent(refSlug)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!live) return;
        if (res.status === 401) {
          setLoggedIn(false);
          return;
        }
        const info = await res.json().catch(() => ({}));
        if (!live) return;
        setLoggedIn(true);
        if (res.ok) {
          if (info.self) {
            setSelf(true);
            return;
          }
          setFirstPay(Boolean(info.firstPay));
          setAlreadySaved(Boolean(info.alreadySaved));
          setKnown(info.known === true);
          setQuickSendEth(typeof info.quickSendEth === 'string' ? info.quickSendEth : '0');
        }
      })
      .catch(() => live && setLoggedIn(false));
    // Only for the "Signed in as" line; the form does not wait for it.
    fetch('/api/dashboard', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok || !live) return;
        const body = await res.json().catch(() => ({}));
        const mine = String(body?.account?.username || '').toLowerCase();
        if (live && mine) setPayerHandle(`@${mine}`);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refSlug]);

  function onReview(e: React.FormEvent) {
    e.preventDefault();
    if (!amountOk) {
      setMsg('Enter an amount above 0.');
      return;
    }
    setMsg('');
    setStage('review');
  }

  async function onPay() {
    if ((needsPin && !pinReady(pin)) || busy) return;
    setBusy(true);
    setMsg('');
    setOk(false);
    try {
      const res = withEth && ethQuote
        ? await fetch('/api/pay/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: refSlug, amount, pin, asset, note, maxEth: ethQuote.maxEth }),
          })
        : await fetch('/api/pay/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: refSlug, amount, pin: needsPin ? pin : '', asset, note }),
          });
      const body = await res.json().catch(() => ({}));
      // A wrong PIN is a 401 too; only a missing session (no code) means sign in.
      if (res.status === 401 && !body.code) {
        window.location.href = `/login?next=${encodeURIComponent(next)}`;
        return;
      }
      if (body.code === 'PIN_REQUIRED') setPinAsked(true);
      if (!res.ok) {
        setMsg(body.error || 'Could not pay.');
        return;
      }
      setOk(true);
      setExplorer(body.explorerUrl || '');
      setTransferId(typeof body.transferId === 'string' ? body.transferId : '');
      setPin('');
      if (body.alreadySaved === true) setAlreadySaved(true);
      else setAlreadySaved(false);
    } catch {
      setMsg('Could not pay. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fade-up mx-auto max-w-md space-y-6">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-gold">Pay</p>
        <h1 className="mt-3 font-sans text-3xl tracking-wide text-paper">
          {displayName || handle}
        </h1>
        {displayName && username ? (
          <p className="mt-1 font-mono text-sm text-muted">@{username}</p>
        ) : null}
      </div>

      {self ? (
        <p className="text-sm text-muted">This is your pay page. Share the QR or @username.</p>
      ) : null}

      {loggedIn === false ? (
        <div className="flex flex-col gap-2">
          <Link
            href={`/login?next=${encodeURIComponent(next)}`}
            className="btn btn-primary no-underline"
          >
            Log in to pay
          </Link>
          <Link
            href={`/signup?next=${encodeURIComponent(next)}`}
            className="btn btn-ghost no-underline"
          >
            Create account
          </Link>
        </div>
      ) : null}

      {loggedIn === false && outsidePay ? (
        <ExternalPay
          refSlug={refSlug}
          presetAmount={preset?.amount ?? null}
          presetAsset={preset?.asset ?? 'ETH'}
          note={note}
          handle={handle}
        />
      ) : null}

      {loggedIn && !self && !ok && stage === 'review' ? (
        <div className="card space-y-4 p-6">
          <p className="text-xs uppercase tracking-[0.18em] text-muted">Review payment</p>
          {firstPay ? (
            <div className="alert alert-warn text-sm">
              First payment. You have not paid {handle} before. Check this is the right
              person before you confirm.
            </div>
          ) : null}
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">To</dt>
              <dd className="m-0 text-right text-paper">
                {displayName ? `${displayName} ` : ''}
                {username ? <span className="font-mono">@{username}</span> : handle}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Amount</dt>
              <dd className="m-0 font-mono text-paper">
                {amount} {unit}
              </dd>
            </div>
            {note ? (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted">For</dt>
                <dd className="m-0 break-words text-right text-paper">{note}</dd>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">From</dt>
              <dd className="m-0 text-right text-paper">{payerHandle ? `${payerHandle}, Flizy wallet` : 'Your Flizy wallet'}</dd>
            </div>
            {withEth && ethQuote ? (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted">You pay</dt>
                <dd className="m-0 text-right font-mono text-paper">up to {ethQuote.maxEth} ETH</dd>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Network fee</dt>
              <dd className="m-0 text-right text-paper">Paid in ETH from your wallet</dd>
            </div>
          </dl>
          {asset !== 'ETH' ? (
            <label className="flex items-start gap-2 text-sm text-muted">
              <input
                type="checkbox"
                className="mt-1"
                checked={withEth}
                disabled={busy}
                onChange={(e) => (e.target.checked ? void quoteWithEth() : (setWithEth(false), setEthQuote(null)))}
              />
              <span>
                Pay with ETH instead. Your ETH is swapped and {handle} receives at least {amount} {unit}. Anything over that
                from the price moving goes to them.
              </span>
            </label>
          ) : null}
          {needsPin ? (
            <PinField id="pay-pin" value={pin} onChange={setPin} />
          ) : txPin.required ? (
            <p className="text-sm text-muted">
              Quick send: no PIN for up to {quickSendEth} ETH to someone you have paid before.
            </p>
          ) : null}
          {msg ? <div className="alert alert-error text-sm">{msg}</div> : null}
          <div className="grid grid-cols-[auto_1fr] gap-2">
            <button
              type="button"
              className="btn btn-ghost px-5 py-3"
              disabled={busy}
              onClick={() => {
                setPin('');
                setMsg('');
                setWithEth(false);
                setEthQuote(null);
                setStage('edit');
              }}
            >
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary py-3 font-semibold"
              disabled={busy || (needsPin && !pinReady(pin))}
              onClick={() => void onPay()}
            >
              {busy ? 'Paying…' : `Confirm and pay ${amount} ${unit}`}
            </button>
          </div>
        </div>
      ) : null}

      {loggedIn && !self && !ok && stage === 'edit' ? (
        <form onSubmit={onReview} className="card space-y-4 p-6">
          <p className="text-sm text-muted">
            {payerHandle
              ? `Signed in as ${payerHandle}. This send comes from your Flizy wallet.`
              : 'Signed in. This send comes from your Flizy wallet.'}
          </p>
          {firstPay ? (
            <div className="alert alert-warn text-sm">
              First payment. You have not paid {handle} before. Confirm the name
              before you send.
            </div>
          ) : null}
          {note ? (
            <p className="m-0 text-sm text-muted">
              For: <span className="break-words text-paper">{note}</span>
              <span className="block text-xs">Written by whoever made this link.</span>
            </p>
          ) : null}
          <div>
            <p className="label" id="pay-asset-label">
              Asset
            </p>
            <div className="mt-1 flex gap-2" role="group" aria-labelledby="pay-asset-label">
              {PAY_ASSETS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={asset === opt ? 'btn btn-primary flex-1 py-2' : 'btn btn-ghost flex-1 py-2'}
                  onClick={() => setAsset(opt)}
                >
                  {symbolLabel(opt)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="pay-amount">
              Amount ({unit})
            </label>
            <input
              id="pay-amount"
              className="input"
              inputMode="decimal"
              placeholder={PLACEHOLDER[asset]}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>
          {msg ? <div className="alert alert-error text-sm">{msg}</div> : null}
          <button type="submit" className="btn btn-primary w-full py-3 font-semibold" disabled={!amountOk}>
            Review payment to {handle}
          </button>
        </form>
      ) : null}

      {loggedIn && !self && ok ? (
        <div className="card space-y-4 p-6">
          <div className="alert alert-ok text-sm">{justSaved ? `Saved ${handle} for later send.` : 'Paid.'}</div>
          {explorer ? (
            <a
              href={explorer}
              className="text-sm text-lime no-underline hover:text-gold"
              target="_blank"
              rel="noreferrer"
            >
              View on explorer
            </a>
          ) : null}
          {transferId ? <ShareReceiptButton transferId={transferId} className="text-sm text-sun disabled:opacity-60" /> : null}
          {!alreadySaved && !saveSkipped ? (
            <div className="space-y-3 border-t border-[var(--border)] pt-4">
              <p className="text-sm text-paper">
                Save {handle} as a trusted contact so the next send is just their name.
              </p>
              <div>
                <label className="label" htmlFor="save-password">
                  Account password
                </label>
                <input
                  id="save-password"
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={savePassword}
                  onChange={(e) => setSavePassword(e.target.value)}
                  required
                />
              </div>
              <button
                type="button"
                className="btn btn-primary w-full py-3 font-semibold"
                disabled={saving || !savePassword}
                onClick={async () => {
                  setSaving(true);
                  setMsg('');
                  try {
                    const res = await fetch('/api/pay/save', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ ref: refSlug, password: savePassword }),
                    });
                    const body = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(body.error || 'Could not save');
                    setAlreadySaved(true);
                    setJustSaved(true);
                    setSavePassword('');
                  } catch (err) {
                    setMsg(err instanceof Error ? err.message : 'Could not save');
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? 'Saving…' : `Save ${handle} for later`}
              </button>
              <button
                type="button"
                className="btn btn-ghost w-full text-sm"
                disabled={saving}
                onClick={() => setSaveSkipped(true)}
              >
                Skip
              </button>
              {msg ? <div className="alert alert-error text-sm">{msg}</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
