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
  const [secret, setSecret] = useState<{ prefix: string; value: string } | null>(null);
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
    setSecret({ prefix: key.prefix, value: String(out.secret || '') });
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
      setSecret({ prefix: key.prefix, value: String(out.secret || '') });
      setCopied(false);
    }
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
          <p className="m-0 font-sans text-[14px] font-semibold text-white">Copy your new key now</p>
          <p className="m-0 mt-1 font-sans text-[12.5px] text-[#cfcfcf]">It is shown once. Flizy keeps only a fingerprint and cannot show it again.</p>
          <code className="mt-3 block break-all rounded-[8px] bg-[#0b0b0c] p-3 font-mono text-[12.5px] text-white">{secret.value}</code>
          <div className="mt-3 flex gap-3">
            <button type="button" onClick={() => void copySecret()} className={BUTTON}>
              {copied ? 'Copied' : 'Copy key'}
            </button>
            <button type="button" onClick={() => setSecret(null)} className="h-[44px] px-2 font-sans text-[13px] text-[#a9a9a9] hover:text-white">
              I saved it
            </button>
          </div>
        </section>
      ) : null}

      {error ? <p className="alert alert-error m-0">{error}</p> : null}

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
