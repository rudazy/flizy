'use client';

import { useCallback, useEffect, useState } from 'react';
import { SecretInput } from './AccountConnections';

/**
 * Secure this wallet, steps 1 and 2: a passkey on the wallet, then Flizy's
 * daily spending permissions signed by it (web/lib/custody/ceremony.ts).
 * A section of the Security card, under its settings.
 *
 * Shown only to pilot accounts; everyone else gets nothing from the status
 * call and this renders nothing, heading included. Ownership still sits with
 * Flizy after both steps, and the section says so.
 */

type Status = {
  pilot: boolean;
  walletReady: boolean;
  passkeys: Array<{ status: string; addedAt: string | null }>;
  delegations: Array<{ symbol: string; expiresAt: string }>;
};

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = (text: string) => {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

const LABEL: Record<string, string> = { ETH: '0.1 ETH', FLZ: '1,000 FLZ', TUSD: '50 tUSD' };

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Something went wrong. Try again.');
  return data;
}

export function SecureWalletPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<'' | 'passkey' | 'sign'>('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/custody/status', { cache: 'no-store' });
      if (res.ok) setStatus((await res.json()) as Status);
    } catch {
      // No card is better than a broken one.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status?.pilot) return null;

  const added = status.passkeys.filter((p) => p.status === 'added');
  const pending = status.passkeys.some((p) => p.status === 'pending');
  const live = new Map(status.delegations.map((d) => [d.symbol, d.expiresAt]));
  const expires = status.delegations.map((d) => d.expiresAt).sort()[0];

  async function addPasskey(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy('passkey');
    try {
      if (!window.PublicKeyCredential) throw new Error('This browser cannot make a passkey.');
      const o = (await post('/api/custody/passkey', { action: 'begin', password })) as {
        challenge: string;
        rpName: string;
        userId: string;
        userName: string;
        excludeKeyIds: string[];
        timeoutMs: number;
      };
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: fromB64(o.challenge),
          rp: { name: o.rpName, id: window.location.hostname },
          user: { id: fromB64(o.userId), name: o.userName, displayName: o.userName },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          attestation: 'none',
          timeout: o.timeoutMs,
          excludeCredentials: o.excludeKeyIds.map((id) => ({ type: 'public-key' as const, id: fromB64(id) })),
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw new Error('No passkey was made.');
      const response = cred.response as AuthenticatorAttestationResponse;
      const spki = typeof response.getPublicKey === 'function' ? response.getPublicKey() : null;
      if (!spki) throw new Error('This browser cannot add a passkey to a wallet. Try Chrome or Safari.');
      setPassword('');
      setAsking(false);
      await post('/api/custody/passkey', {
        action: 'finish',
        credentialId: b64(cred.rawId),
        clientDataJSON: b64(response.clientDataJSON),
        publicKey: b64(spki),
        publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
      });
    } catch (err) {
      setError(err instanceof Error && err.name !== 'NotAllowedError' ? err.message : 'The passkey was not made.');
    } finally {
      setBusy('');
      await load();
    }
  }

  async function signPermissions() {
    setError('');
    setBusy('sign');
    try {
      const { keyIds, requests } = (await post('/api/custody/delegations', { action: 'begin' })) as {
        keyIds: string[];
        requests: Array<{ id: string; symbol: string; challenge: string }>;
      };
      const answers = [];
      // One tap per asset: each permission is its own digest.
      for (const r of requests) {
        const got = (await navigator.credentials.get({
          publicKey: {
            challenge: fromB64(r.challenge),
            rpId: window.location.hostname,
            allowCredentials: keyIds.map((id) => ({ type: 'public-key' as const, id: fromB64(id) })),
            userVerification: 'required',
          },
        })) as PublicKeyCredential | null;
        if (!got) throw new Error('The permissions were not signed.');
        const a = got.response as AuthenticatorAssertionResponse;
        answers.push({
          id: r.id,
          credentialId: b64(got.rawId),
          authenticatorData: b64(a.authenticatorData),
          clientDataJSON: b64(a.clientDataJSON),
          signature: b64(a.signature),
        });
      }
      await post('/api/custody/delegations', { action: 'finish', answers });
    } catch (err) {
      setError(err instanceof Error && err.name !== 'NotAllowedError' ? err.message : 'The permissions were not signed.');
    } finally {
      setBusy('');
      await load();
    }
  }

  return (
    <div className="grid gap-2.5">
      <p className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[#b7b1a8]">Secure your wallet</p>
      <div className="grid gap-3">
        <p className="m-0 font-sans text-[13.5px] leading-relaxed text-[#b7b1a8]">
          Put your own passkey on your wallet, then let Flizy spend only a small daily amount for you. Flizy still holds the owner key
          until the last step.
        </p>
        {!status.walletReady ? (
          <p className="m-0 font-sans text-[13.5px] text-[#e0b070]">This account&apos;s wallet cannot take a passkey yet.</p>
        ) : null}

        <Step n={1} title="Passkey on your wallet" done={added.length > 0}>
          {added.length ? (
            <p className="m-0 font-sans text-[13.5px] text-[#b7b1a8]">
              {added.length === 1 ? 'One passkey' : `${added.length} passkeys`} on your wallet.
            </p>
          ) : pending ? (
            <p className="m-0 font-sans text-[13.5px] text-[#b7b1a8]">Sent to your wallet. Waiting for the network.</p>
          ) : asking ? (
            <form onSubmit={(e) => void addPasskey(e)} className="grid gap-3">
              <SecretInput value={password} onChange={setPassword} placeholder="Account password" autoFocus />
              <button
                type="submit"
                disabled={busy !== '' || !password}
                className="btn-sun h-[44px] rounded-[10px] font-sans text-[14px] font-semibold disabled:opacity-50"
              >
                {busy === 'passkey' ? 'Adding to your wallet' : 'Make a passkey'}
              </button>
            </form>
          ) : (
            <button
              type="button"
              disabled={!status.walletReady || busy !== ''}
              onClick={() => setAsking(true)}
              className="btn-sun h-[44px] rounded-[10px] font-sans text-[14px] font-semibold disabled:opacity-50"
            >
              Add a passkey
            </button>
          )}
        </Step>

        <Step n={2} title="Daily spending permissions" done={live.size === 3}>
          <p className="m-0 font-sans text-[13.5px] leading-relaxed text-[#b7b1a8]">
            Flizy may send up to {Object.values(LABEL).join(', ')} a day from your wallet for chat payments. Anything more asks for your
            passkey. {expires ? `Signed until ${new Date(expires).toLocaleDateString('en-GB', { dateStyle: 'medium' })}.` : ''}
          </p>
          <button
            type="button"
            disabled={!added.length || busy !== ''}
            onClick={() => void signPermissions()}
            className="h-[44px] rounded-[10px] border border-[#3a3833] bg-[#0c0b0a] font-sans text-[14px] text-white hover:opacity-80 disabled:opacity-50"
          >
            {busy === 'sign' ? 'Waiting for your passkey' : live.size ? 'Sign again' : 'Sign with your passkey'}
          </button>
        </Step>

        <Step n={3} title="Your wallet, your key" done={false}>
          <p className="m-0 font-sans text-[13.5px] text-[#8f877c]">Moving ownership to you comes next. Not open yet.</p>
        </Step>

        {error ? (
          <p className="m-0 font-sans text-[13px] text-[#e0b070]" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <div className="grid gap-3 rounded-[14px] border border-[#2e2e33] bg-[#0f0f10] p-4">
      <div className="flex items-center gap-3">
        <span
          className={`flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full font-sans text-[13px] font-semibold ${
            done ? 'bg-sun text-sun-ink' : 'border border-[#3a3833] text-[#d9d4ca]'
          }`}
        >
          {done ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-label="Done">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          ) : (
            n
          )}
        </span>
        <p className="m-0 font-sans text-[15px] font-semibold text-white">{title}</p>
      </div>
      {children}
    </div>
  );
}
