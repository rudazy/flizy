'use client';

import { useCallback, useEffect, useState } from 'react';
import { PREF_CARD, PrefHero } from './AccountPrefs';
import { SecretInput } from './AccountConnections';
import { displaySafeLabel } from '../lib/sanitize';

/**
 * Account, Developers: an approved platform's Flizy Pay API keys.
 *
 * Shown only to accounts Flizy approved as platforms (the page asks
 * /api/developers and hides the section on 404). A key can be created with
 * `read` and `collect`; `payout` is granted by Flizy and shown here once it is.
 * A new or rotated key's secret is shown once, in this session only, and never
 * again. Creating, rotating and revoking take the account password.
 *
 * Payout allowance: API payouts spend only through an allowance the account's
 * passkey signs here, one per asset Flizy enabled, up to that asset's daily
 * maximum, for 30 days (web/lib/apiAllowance.ts).
 *
 * Webhooks: endpoints are added and removed with the account password; a new
 * endpoint's signing secret is shown once. The latest payouts and webhook
 * deliveries are listed, and a delivery not yet delivered can be sent again.
 *
 * Checkouts: the sites a checkout may send the payer back to are registered
 * and removed here with the account password; the latest payments are listed.
 */

type Key = {
  id: string;
  label: string;
  prefix: string;
  mode: 'test' | 'live';
  scopes: string[];
  ipAllowlist: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type DevData = {
  platform: { name: string; wallet: string; enabled: boolean; feeBps: number; claimExpiryDays: number; claimExpiryMaxDays: number };
  mode: 'test' | 'live';
  payoutsEnabled: boolean;
  keys: Key[];
  limits: Array<{ symbol: string; maxPayout: string; dailyMax: string }>;
  allowances: Array<{ symbol: string; perDay: string; expiresAt: string }>;
  payouts: Array<{ id: string; state: string; amount: string; asset: string; recipient: { type: string; value: string }; error_code: string | null; created_at: string }>;
  endpoints: Array<{ id: string; url: string; label: string; events: string[]; enabled: boolean; secretHint: string | null; createdAt: string }>;
  deliveries: Array<{ id: string; eventType: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string }>;
  payments: Array<{ id: string; state: string; amount: string; asset: string; received: string; overpaid: boolean; reference: string | null; created_at: string }>;
  origins: string[];
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

const BUTTON = 'h-[44px] rounded-[10px] border border-[#5a4a1f] px-4 font-sans text-[14px] font-medium text-sun hover:border-sun/70 disabled:opacity-50';
const FIELD = 'h-[44px] w-full rounded-[10px] border border-[#2a2b30] bg-[#0b0b0c] px-3 font-sans text-[14px] text-white outline-none focus:border-[#5a4a1f]';

function when(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Load the Developers data. 404 means this account is not an approved platform. */
export async function loadDevelopers(): Promise<DevData | null> {
  const res = await fetch('/api/developers', { cache: 'no-store' });
  if (res.status === 404 || res.status === 401) return null;
  if (!res.ok) throw new Error('Could not load your API keys.');
  return (await res.json()) as DevData;
}

export function AccountDevelopers() {
  const [data, setData] = useState<DevData | null>(null);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [read, setRead] = useState(true);
  const [collect, setCollect] = useState(false);
  const [ips, setIps] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ prefix: string; value: string; kind: 'key' | 'webhook' } | null>(null);
  const [hookUrl, setHookUrl] = useState('');
  const [hookLabel, setHookLabel] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [newOrigin, setNewOrigin] = useState('');
  const [removingOrigin, setRemovingOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<{ id: string; action: 'revoke' | 'rotate' } | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await loadDevelopers());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your API keys.');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function post(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data: json };
  }

  async function create() {
    setBusy('create');
    setError('');
    const scopes = [read ? 'read' : null, collect ? 'collect' : null].filter(Boolean);
    const { ok, data: out } = await post('/api/developers/keys', { label, scopes, ipAllowlist: ips, password });
    setBusy(null);
    if (!ok) {
      setError(typeof out.error === 'string' ? out.error : 'Could not create the key.');
      return;
    }
    const key = out.key as Key;
    setSecret({ prefix: key.prefix, value: String(out.secret || ''), kind: 'key' });
    setCopied(false);
    setLabel('');
    setIps('');
    setPassword('');
    await reload();
  }

  async function act(id: string, action: 'revoke' | 'rotate') {
    setBusy(`${action}:${id}`);
    setError('');
    const { ok, data: out } = await post(`/api/developers/keys/${id}/${action}`, { password });
    setBusy(null);
    if (!ok) {
      setError(typeof out.error === 'string' ? out.error : `Could not ${action} the key.`);
      return;
    }
    setConfirming(null);
    setPassword('');
    if (action === 'rotate') {
      const key = out.key as Key;
      setSecret({ prefix: key.prefix, value: String(out.secret || ''), kind: 'key' });
      setCopied(false);
    }
    await reload();
  }

  /** One passkey tap per asset: each allowance is its own digest. */
  async function signAllowance() {
    setBusy('allowance');
    setError('');
    try {
      const begun = await post('/api/developers/allowance', { action: 'begin' });
      if (!begun.ok) throw new Error(typeof begun.data.error === 'string' ? begun.data.error : 'Could not start the allowance.');
      const { keyIds, requests } = begun.data as { keyIds: string[]; requests: Array<{ id: string; challenge: string }> };
      const answers = [];
      for (const r of requests) {
        const got = (await navigator.credentials.get({
          publicKey: {
            challenge: fromB64(r.challenge),
            rpId: window.location.hostname,
            allowCredentials: keyIds.map((id) => ({ type: 'public-key' as const, id: fromB64(id) })),
            userVerification: 'required',
          },
        })) as PublicKeyCredential | null;
        if (!got) throw new Error('The allowance was not signed.');
        const a = got.response as AuthenticatorAssertionResponse;
        answers.push({
          id: r.id,
          credentialId: b64(got.rawId),
          authenticatorData: b64(a.authenticatorData),
          clientDataJSON: b64(a.clientDataJSON),
          signature: b64(a.signature),
        });
      }
      const done = await post('/api/developers/allowance', { action: 'finish', answers });
      if (!done.ok) throw new Error(typeof done.data.error === 'string' ? done.data.error : 'The allowance was not signed.');
    } catch (err) {
      setError(err instanceof Error && err.name !== 'NotAllowedError' ? err.message : 'The allowance was not signed.');
    } finally {
      setBusy(null);
      await reload();
    }
  }

  async function addEndpoint() {
    setBusy('hook');
    setError('');
    const { ok, data: out } = await post('/api/developers/webhooks', { url: hookUrl, label: hookLabel, password });
    setBusy(null);
    if (!ok) {
      setError(typeof out.error === 'string' ? out.error : 'Could not add the endpoint.');
      return;
    }
    setSecret({ prefix: '', value: String(out.secret || ''), kind: 'webhook' });
    setCopied(false);
    setHookUrl('');
    setHookLabel('');
    setPassword('');
    await reload();
  }

  async function removeEndpoint(id: string) {
    setBusy(`hook:${id}`);
    setError('');
    const { ok, data: out } = await post(`/api/developers/webhooks/${id}/delete`, { password });
    setBusy(null);
    if (!ok) {
      setError(typeof out.error === 'string' ? out.error : 'Could not remove the endpoint.');
      return;
    }
    setRemoving(null);
    setPassword('');
    await reload();
  }

  async function addSite() {
    setBusy('origin');
    setError('');
    const { ok, data: out } = await post('/api/developers/origins', { origin: newOrigin, password });
    setBusy(null);
    if (!ok) {
      setError(typeof out.error === 'string' ? out.error : 'Could not add the site.');
      return;
    }
    setNewOrigin('');
    setPassword('');
    await reload();
  }

  async function removeSite(origin: string) {
    setBusy(`origin:${origin}`);
    setError('');
    const { ok, data: out } = await post('/api/developers/origins/remove', { origin, password });
    setBusy(null);
    if (!ok) {
      setError(typeof out.error === 'string' ? out.error : 'Could not remove the site.');
      return;
    }
    setRemovingOrigin(null);
    setPassword('');
    await reload();
  }

  async function retry(id: string) {
    setBusy(`retry:${id}`);
    setError('');
    const { ok, data: out } = await post(`/api/developers/webhooks/deliveries/${id}/retry`, {});
    setBusy(null);
    if (!ok) setError(typeof out.error === 'string' ? out.error : 'Could not send it again.');
    await reload();
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (!data) {
    return error ? <p className="alert alert-error m-0">{error}</p> : <p className="m-0 font-sans text-[13px] text-[#a9a9a9]">Loading...</p>;
  }

  const { platform } = data;
  const active = data.keys.filter((k) => !k.revokedAt);
  const revoked = data.keys.filter((k) => k.revokedAt);

  return (
    <div className="grid gap-4">
      <section className={PREF_CARD}>
        <PrefHero
          eyebrow="Flizy Pay API"
          title="Developers"
          text={`API keys for ${displaySafeLabel(platform.name, 60)}. Your platform pays out and collects through Flizy with these keys.`}
        />
        <dl className="m-0 grid gap-2 px-5 pb-5 font-sans text-[13.5px]">
          <Row name="Platform" value={displaySafeLabel(platform.name, 60)} />
          <Row name="Status" value={platform.enabled ? 'Approved' : 'Paused by Flizy'} />
          <Row name="Payout wallet" value={`${platform.wallet.slice(0, 6)}...${platform.wallet.slice(-4)}`} />
          <Row name="Mode" value={data.mode === 'test' ? 'Test (GIWA Sepolia)' : 'Live'} />
          <Row name="Fee" value={`${(platform.feeBps / 100).toFixed(2)}%`} />
          <Row name="Claim expiry" value={`${platform.claimExpiryDays} days (up to ${platform.claimExpiryMaxDays})`} />
          <Row name="API payouts" value={data.payoutsEnabled ? 'On' : 'Off'} />
        </dl>
      </section>

      {secret ? (
        <section className="rounded-[14px] border border-[#5a4a1f] bg-[#16130b] p-4">
          <p className="m-0 font-sans text-[14px] font-semibold text-white">
            {secret.kind === 'webhook' ? 'Copy your webhook signing secret now' : 'Copy your new key now'}
          </p>
          <p className="m-0 mt-1 font-sans text-[12.5px] text-[#cfcfcf]">
            {secret.kind === 'webhook'
              ? 'It is shown once. Flizy keeps it encrypted, only to sign deliveries, and cannot show it again.'
              : 'It is shown once. Flizy keeps only a fingerprint and cannot show it again.'}
          </p>
          <code className="mt-3 block break-all rounded-[8px] bg-[#0b0b0c] p-3 font-mono text-[12.5px] text-white">{secret.value}</code>
          <div className="mt-3 flex gap-3">
            <button type="button" onClick={() => void copySecret()} className={BUTTON}>
              {copied ? 'Copied' : secret.kind === 'webhook' ? 'Copy secret' : 'Copy key'}
            </button>
            <button type="button" onClick={() => setSecret(null)} className="h-[44px] px-2 font-sans text-[13px] text-[#a9a9a9] hover:text-white">
              I saved it
            </button>
          </div>
        </section>
      ) : null}

      {error ? <p className="alert alert-error m-0">{error}</p> : null}

      <section className="rounded-[14px] border border-[#2a2b30] bg-[#0f0f10] p-4">
        <p className="m-0 font-sans text-[15px] font-semibold text-white">Payout allowance</p>
        <p className="m-0 mt-1 font-sans text-[12.5px] leading-relaxed text-[#cfcfcf]">
          API payouts spend only through an allowance your passkey signs, up to the daily maximum for each asset. The chain enforces
          it. A payout over what is left today fails; it is never sent another way.
        </p>
        {data.limits.length === 0 ? (
          <p className="m-0 mt-3 font-sans text-[13px] text-[#a9a9a9]">Flizy has not enabled payouts in any asset for your platform yet.</p>
        ) : (
          <ul className="m-0 mt-3 grid list-none gap-2 p-0 font-sans text-[13px]">
            {data.limits.map((l) => {
              const live = data.allowances.find((a) => a.symbol === l.symbol);
              return (
                <li key={l.symbol} className="rounded-[10px] border border-[#24252a] p-3">
                  <p className="m-0 text-white">
                    Up to {l.maxPayout} per payout, {l.dailyMax} a day
                  </p>
                  <p className="m-0 mt-1 text-[12px] text-[#8a8a8a]">
                    {live ? `Allowance signed: ${live.perDay} a day, until ${when(live.expiresAt)}` : 'No allowance signed'}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        {data.limits.length && platform.enabled ? (
          <button type="button" disabled={busy != null} onClick={() => void signAllowance()} className={`${BUTTON} mt-3`}>
            {busy === 'allowance' ? 'Waiting for your passkey...' : data.allowances.length ? 'Renew with passkey' : 'Sign with passkey'}
          </button>
        ) : null}
      </section>

      <section className="rounded-[14px] border border-[#2a2b30] bg-[#0f0f10] p-4">
        <p className="m-0 font-sans text-[15px] font-semibold text-white">API keys</p>
        {active.length === 0 ? <p className="m-0 mt-2 font-sans text-[13px] text-[#a9a9a9]">No active keys yet.</p> : null}
        <ul className="m-0 mt-3 grid list-none gap-3 p-0">
          {active.map((k) => (
            <li key={k.id} className="rounded-[10px] border border-[#24252a] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[13px] text-white">{k.prefix}...</span>
                <span className="font-sans text-[12px] text-[#a9a9a9]">{k.label || 'No label'}</span>
              </div>
              <p className="m-0 mt-1 font-sans text-[12.5px] text-[#cfcfcf]">
                Permissions: {k.scopes.join(', ')}
                {k.ipAllowlist.length ? ` · IPs: ${k.ipAllowlist.join(', ')}` : ''}
              </p>
              <p className="m-0 mt-1 font-sans text-[12px] text-[#8a8a8a]">
                Created {when(k.createdAt)} · last used {when(k.lastUsedAt)}
              </p>
              {confirming?.id === k.id ? (
                <div className="mt-3 grid gap-2">
                  <SecretInput value={password} onChange={setPassword} placeholder="Account password" label="Account password" />
                  <div className="flex gap-3">
                    <button
                      type="button"
                      disabled={!password || busy != null}
                      onClick={() => void act(k.id, confirming.action)}
                      className={BUTTON}
                    >
                      {busy ? '...' : confirming.action === 'revoke' ? 'Revoke now' : 'Rotate now'}
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} className="h-[44px] px-2 font-sans text-[13px] text-[#a9a9a9]">
                      Cancel
                    </button>
                  </div>
                  <p className="m-0 font-sans text-[12px] text-[#8a8a8a]">
                    {confirming.action === 'revoke'
                      ? 'This key stops working at once. Other keys are not affected.'
                      : 'A new key with the same permissions replaces this one, which stops working at once.'}
                  </p>
                </div>
              ) : (
                <div className="mt-3 flex gap-3">
                  <button type="button" onClick={() => setConfirming({ id: k.id, action: 'rotate' })} className={BUTTON}>
                    Rotate
                  </button>
                  <button type="button" onClick={() => setConfirming({ id: k.id, action: 'revoke' })} className={BUTTON}>
                    Revoke
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {revoked.length ? (
          <p className="m-0 mt-3 font-sans text-[12px] text-[#8a8a8a]">
            Revoked: {revoked.map((k) => `${k.prefix}...`).join(', ')}
          </p>
        ) : null}
      </section>

      {platform.enabled ? (
        <section className="rounded-[14px] border border-[#2a2b30] bg-[#0f0f10] p-4">
          <p className="m-0 font-sans text-[15px] font-semibold text-white">Create a key</p>
          <div className="mt-3 grid gap-3">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, e.g. Production server" maxLength={60} className={FIELD} />
            <div className="flex flex-wrap gap-4 font-sans text-[13.5px] text-white">
              <label className="flex min-h-[44px] items-center gap-2">
                <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> Read
              </label>
              <label className="flex min-h-[44px] items-center gap-2">
                <input type="checkbox" checked={collect} onChange={(e) => setCollect(e.target.checked)} /> Collect
              </label>
            </div>
            <p className="m-0 font-sans text-[12px] text-[#8a8a8a]">Payout permission is granted per key by Flizy after review.</p>
            <input value={ips} onChange={(e) => setIps(e.target.value)} placeholder="IP allowlist (optional, comma separated)" className={FIELD} />
            {confirming ? null : <SecretInput value={password} onChange={setPassword} placeholder="Account password" label="Account password" />}
            <button type="button" disabled={busy != null || !password || (!read && !collect) || confirming != null} onClick={() => void create()} className={BUTTON}>
              {busy === 'create' ? 'Creating...' : 'Create key'}
            </button>
          </div>
        </section>
      ) : null}

      <section className="rounded-[14px] border border-[#2a2b30] bg-[#0f0f10] p-4">
        <p className="m-0 font-sans text-[15px] font-semibold text-white">Checkout sites</p>
        <p className="m-0 mt-1 font-sans text-[12.5px] leading-relaxed text-[#cfcfcf]">
          A checkout&apos;s return link must be on one of these sites, so Flizy&apos;s checkout page never sends your customers anywhere else.
        </p>
        <ul className="m-0 mt-3 grid list-none gap-2 p-0">
          {data.origins.map((o) => (
            <li key={o} className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1f2024] pt-2">
              <span className="font-mono text-[12.5px] text-white">{o}</span>
              {removingOrigin === o ? (
                <span className="flex gap-2">
                  <button type="button" disabled={!password || busy != null} onClick={() => void removeSite(o)} className={BUTTON}>
                    {busy === `origin:${o}` ? '...' : 'Remove now'}
                  </button>
                  <button type="button" onClick={() => setRemovingOrigin(null)} className="h-[44px] px-2 font-sans text-[13px] text-[#a9a9a9]">
                    Cancel
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => setRemovingOrigin(o)} className="h-[44px] px-2 font-sans text-[13px] text-sun hover:opacity-80">
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        {removingOrigin ? <SecretInput value={password} onChange={setPassword} placeholder="Account password" label="Account password" /> : null}
        {platform.enabled && data.origins.length < 5 && !removingOrigin ? (
          <div className="mt-3 grid gap-3">
            <input value={newOrigin} onChange={(e) => setNewOrigin(e.target.value)} placeholder="https://your-shop.example" maxLength={260} className={FIELD} />
            {confirming || removing ? null : <SecretInput value={password} onChange={setPassword} placeholder="Account password" label="Account password" />}
            <button type="button" disabled={busy != null || !password || !newOrigin || confirming != null || removing != null} onClick={() => void addSite()} className={BUTTON}>
              {busy === 'origin' ? 'Adding...' : 'Add site'}
            </button>
          </div>
        ) : null}
      </section>

      <section className="rounded-[14px] border border-[#2a2b30] bg-[#0f0f10] p-4">
        <p className="m-0 font-sans text-[15px] font-semibold text-white">Recent payments</p>
        {data.payments.length === 0 ? <p className="m-0 mt-2 font-sans text-[13px] text-[#a9a9a9]">No checkouts yet.</p> : null}
        <ul className="m-0 mt-3 grid list-none gap-2 p-0 font-sans text-[12.5px]">
          {data.payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1f2024] pt-2">
              <span className="text-white">
                {p.amount} {p.asset}
                {p.reference ? ` · ${p.reference}` : ''}
              </span>
              <span className="text-[#a9a9a9]">
                {p.state}
                {p.received !== '0' && p.state === 'accepted' ? ` (${p.received} received)` : ''}
                {p.overpaid ? ' (overpaid)' : ''} · {when(p.created_at)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-[14px] border border-[#2a2b30] bg-[#0f0f10] p-4">
        <p className="m-0 font-sans text-[15px] font-semibold text-white">Webhooks</p>
        <p className="m-0 mt-1 font-sans text-[12.5px] leading-relaxed text-[#cfcfcf]">
          Every payout state change is sent to your endpoints, signed with Flizy-Signature. Dedupe by the event id: a retry sends the
          same event again.
        </p>
        {data.endpoints.length === 0 ? <p className="m-0 mt-3 font-sans text-[13px] text-[#a9a9a9]">No endpoints yet.</p> : null}
        <ul className="m-0 mt-3 grid list-none gap-3 p-0">
          {data.endpoints.map((e) => (
            <li key={e.id} className="rounded-[10px] border border-[#24252a] p-3">
              <p className="m-0 break-all font-mono text-[12.5px] text-white">{e.url}</p>
              <p className="m-0 mt-1 font-sans text-[12px] text-[#8a8a8a]">
                {e.label || 'No label'} · {e.events.length ? e.events.join(', ') : 'all events'} · secret ...{e.secretHint || ''}
              </p>
              {removing === e.id ? (
                <div className="mt-3 grid gap-2">
                  <SecretInput value={password} onChange={setPassword} placeholder="Account password" label="Account password" />
                  <div className="flex gap-3">
                    <button type="button" disabled={!password || busy != null} onClick={() => void removeEndpoint(e.id)} className={BUTTON}>
                      {busy === `hook:${e.id}` ? '...' : 'Remove now'}
                    </button>
                    <button type="button" onClick={() => setRemoving(null)} className="h-[44px] px-2 font-sans text-[13px] text-[#a9a9a9]">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setRemoving(e.id)} className={`${BUTTON} mt-3`}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        {platform.enabled && data.endpoints.length < 5 ? (
          <div className="mt-3 grid gap-3">
            <input value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://your-server.example/flizy" maxLength={2000} className={FIELD} />
            <input value={hookLabel} onChange={(e) => setHookLabel(e.target.value)} placeholder="Label (optional)" maxLength={60} className={FIELD} />
            {confirming || removing ? null : <SecretInput value={password} onChange={setPassword} placeholder="Account password" label="Account password" />}
            <button type="button" disabled={busy != null || !password || !hookUrl || confirming != null || removing != null} onClick={() => void addEndpoint()} className={BUTTON}>
              {busy === 'hook' ? 'Adding...' : 'Add endpoint'}
            </button>
          </div>
        ) : null}
      </section>

      <section className="rounded-[14px] border border-[#2a2b30] bg-[#0f0f10] p-4">
        <p className="m-0 font-sans text-[15px] font-semibold text-white">Recent payouts</p>
        {data.payouts.length === 0 ? <p className="m-0 mt-2 font-sans text-[13px] text-[#a9a9a9]">No payouts yet.</p> : null}
        <ul className="m-0 mt-3 grid list-none gap-2 p-0 font-sans text-[12.5px]">
          {data.payouts.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1f2024] pt-2">
              <span className="text-white">
                {p.amount} {p.asset} to {p.recipient.type} {p.recipient.value}
              </span>
              <span className="text-[#a9a9a9]">
                {p.state}
                {p.error_code ? ` (${p.error_code})` : ''} · {when(p.created_at)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-[14px] border border-[#2a2b30] bg-[#0f0f10] p-4">
        <p className="m-0 font-sans text-[15px] font-semibold text-white">Recent deliveries</p>
        {data.deliveries.length === 0 ? <p className="m-0 mt-2 font-sans text-[13px] text-[#a9a9a9]">No deliveries yet.</p> : null}
        <ul className="m-0 mt-3 grid list-none gap-2 p-0 font-sans text-[12.5px]">
          {data.deliveries.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1f2024] pt-2">
              <span className="text-white">{d.eventType}</span>
              <span className="text-[#a9a9a9]">
                {d.status}, {d.attempts} {d.attempts === 1 ? 'try' : 'tries'}
                {d.lastError ? ` · ${d.lastError}` : ''}
              </span>
              {d.status !== 'delivered' ? (
                <button type="button" disabled={busy != null} onClick={() => void retry(d.id)} className="h-[44px] px-2 font-sans text-[13px] text-sun hover:opacity-80 disabled:opacity-50">
                  {busy === `retry:${d.id}` ? '...' : 'Send again'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Row({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[#1f2024] pt-2">
      <dt className="text-[#a9a9a9]">{name}</dt>
      <dd className="m-0 text-right text-white">{value}</dd>
    </div>
  );
}
