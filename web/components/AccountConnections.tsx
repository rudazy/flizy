'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HeroArt, PREF_CARD, PrefHero } from './AccountPrefs';

/**
 * Account Chat and Trusted slides, and the brand tiles Platforms shares.
 * Behaviour is the page's: these only draw it. Brand colours stay out where
 * they are blue (Telegram, Discord): those tiles are gold in this palette.
 */

export type Brand = 'whatsapp' | 'telegram' | 'github' | 'discord' | 'x';

const BRAND_NAME: Record<Brand, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  github: 'GitHub',
  discord: 'Discord',
  x: 'X',
};

export function BrandTile({ brand, dim = false }: { brand: Brand; dim?: boolean }) {
  return (
    <img
      src={`/account/tile-${brand}.webp`}
      alt=""
      aria-hidden
      draggable={false}
      className={`h-[52px] w-[52px] shrink-0 select-none rounded-[14px] object-cover ${dim ? 'opacity-45 grayscale' : ''}`}
    />
  );
}

/** "Linked" with a dot: green for a linked account, gold on gold-tinted cards. */
export function LinkedChip({ tone = 'green' }: { tone?: 'green' | 'gold' }) {
  const cls =
    tone === 'gold'
      ? 'border-[#5a4a1f] bg-[#2a2210] text-sun'
      : 'border-[#1f4a2c] bg-[#0f2a18] text-[#4ade80]';
  return (
    <span className={`inline-flex h-[24px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 font-sans text-[12px] font-medium ${cls}`}>
      Linked
      <span className={`h-[7px] w-[7px] rounded-full ${tone === 'gold' ? 'bg-sun' : 'bg-[#4ade80]'}`} aria-hidden />
    </span>
  );
}

/** A tinted card per app: green for WhatsApp, warm gold for the rest. */
export function brandCard(brand: Brand, linked: boolean): string {
  if (!linked) return 'border-[#26262a] bg-[#0f0f10]';
  if (brand === 'whatsapp') {
    return 'border-[#1d4a2a] bg-[radial-gradient(120%_140%_at_100%_100%,rgba(34,197,94,0.16),rgba(15,15,16,0)_60%),#0d1410]';
  }
  return 'border-[#4a3d1c] bg-[radial-gradient(120%_140%_at_100%_100%,rgba(247,208,71,0.12),rgba(15,15,16,0)_60%),#12100b]';
}

export function GhostButton({ children, ...rest }: { children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex h-[44px] shrink-0 items-center justify-center rounded-[10px] border border-[#4a4a50] bg-transparent px-5 font-sans text-[14px] font-medium text-white transition-colors hover:border-[#6a6a70] disabled:cursor-not-allowed disabled:opacity-45 ${rest.className ?? ''}`}
    >
      {children}
    </button>
  );
}

export function InfoNote({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'gold' }) {
  return (
    <div
      className={`flex items-start gap-3 rounded-[12px] border p-3.5 ${
        tone === 'gold' ? 'border-[#3a3017] bg-[#16130b]' : 'border-[#26262a] bg-[#0f0f10]'
      }`}
    >
      <span
        className={`mt-[1px] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border font-serif text-[12px] font-bold italic ${
          tone === 'gold' ? 'border-sun/60 bg-[#2a2210] text-sun' : 'border-[#6a6a70] text-[#b7b1a8]'
        }`}
        aria-hidden
      >
        i
      </span>
      <div className="min-w-0 font-sans text-[13px] leading-[1.6] text-[#b7b1a8]">{children}</div>
    </div>
  );
}

/** Password prompt shared by every unlink and remove. A form, so Enter submits. */
export function ConfirmPassword({
  intro,
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  confirmLabel,
  busyLabel,
}: {
  intro: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  confirmLabel: string;
  busyLabel: string;
}) {
  return (
    <form
      className="mt-3 grid gap-2.5 border-t border-[#26262a] pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <p className="m-0 font-sans text-[12.5px] leading-[1.55] text-[#9a958c]">{intro}</p>
      <SecretInput value={value} onChange={onChange} placeholder="Account password" autoFocus />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !value}
          className="btn-sun h-[42px] flex-1 rounded-[10px] font-sans text-[13.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? busyLabel : confirmLabel}
        </button>
        <GhostButton onClick={onCancel} disabled={busy} className="h-[42px]">
          Cancel
        </GhostButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const FIELD =
  'flex min-h-[54px] w-full items-center gap-3 rounded-[12px] border border-[#2e2e33] bg-[#0d0d0e] px-4 transition-colors focus-within:border-sun/70';
const FIELD_INPUT =
  'min-w-0 flex-1 bg-transparent font-sans text-[15px] text-white outline-none placeholder:text-[#6f6a62]';

export function SecretInput({
  value,
  onChange,
  placeholder,
  autoFocus = false,
  id,
  autoComplete = 'current-password',
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  id?: string;
  autoComplete?: 'current-password' | 'new-password';
  /** Accessible name when no visible label points at the field. */
  label?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <label className={FIELD}>
      <span className="text-[#b7b1a8]">
        <LockGlyph />
      </span>
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        className={FIELD_INPUT}
        placeholder={placeholder}
        value={value}
        autoComplete={autoComplete}
        aria-label={label}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        className="hit-44 flex h-[32px] w-[32px] items-center justify-center text-[#b7b1a8] hover:text-white"
      >
        <EyeGlyph off={shown} />
      </button>
    </label>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="font-mono text-[10.5px] font-medium uppercase tracking-[0.22em] text-[#d9d4ca]">
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Chat apps
// ---------------------------------------------------------------------------

type ChatLink = { channel: string; phone: string | null; has_phone: boolean };
type LinkCode = { code: string; waDeepLink: string; telegramDeepLink?: string | null; expiresAt: string };

const CHAT_APPS: Array<'whatsapp' | 'telegram'> = ['whatsapp', 'telegram'];

export function ChatAppsPanel({
  links,
  code,
  generating,
  onGenerate,
  unlinking,
  password,
  onPassword,
  onToggleUnlink,
  onConfirmUnlink,
  unlinkBusy,
  awaiting,
  onStart,
}: {
  links: ChatLink[];
  code: LinkCode | null;
  generating: boolean;
  onGenerate: () => void;
  /** The app whose password prompt is open. */
  unlinking: string | null;
  password: string;
  onPassword: (value: string) => void;
  onToggleUnlink: (channel: string) => void;
  onConfirmUnlink: (channel: string) => void;
  unlinkBusy: boolean;
  /** The app the person went off to link, while the page waits for it. */
  awaiting: 'whatsapp' | 'telegram' | null;
  onStart: (channel: 'whatsapp' | 'telegram') => void;
}) {
  const [copied, setCopied] = useState(false);
  const linkedCount = CHAT_APPS.filter((app) => links.some((l) => l.channel === app)).length;

  async function copyMessage() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(`flizy link ${code.code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className={PREF_CARD}>
      <PrefHero
        eyebrow="Chat apps"
        title="Connect your"
        accent="chat apps"
        text="Link WhatsApp or Telegram with a one-time code. Unlink anytime (password). Phone claims only pay out in the chat where the number is proven."
        art={<HeroArt src="/account/chat-hero.webp" />}
      />
      <div className="h-px bg-[linear-gradient(90deg,transparent,rgba(247,208,71,0.28),transparent)]" />

      <div className="grid gap-3 px-4 pb-5 pt-5">
        <div className="flex items-center justify-between">
          <p className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[#d9d4ca]">Linked apps</p>
          <span className="inline-flex h-[30px] min-w-[54px] items-center justify-center rounded-[8px] border border-[#5a4a1f] px-2.5 font-mono text-[13px] text-sun">
            {linkedCount} / {CHAT_APPS.length}
          </span>
        </div>

        {CHAT_APPS.map((app) => {
          const row = links.find((l) => l.channel === app) || null;
          const name = BRAND_NAME[app];
          return (
            <div key={app} className={`rounded-[16px] border p-4 ${brandCard(app, Boolean(row))}`}>
              <div className="flex items-center gap-4">
                <BrandTile brand={app} dim={!row} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-sans text-[16px] font-semibold text-white">{name}</span>
                    {row ? <LinkedChip tone={app === 'whatsapp' ? 'green' : 'gold'} /> : null}
                  </div>
                  {row ? (
                    <>
                      <p className="m-0 mt-1 truncate font-sans text-[15px] font-medium text-sun">
                        {row.phone || (row.has_phone ? 'Phone on file' : 'No phone yet')}
                      </p>
                      <p className="m-0 mt-0.5 font-sans text-[12.5px] text-[#9a958c]">
                        {row.has_phone || row.phone ? 'Linked and verified' : 'Linked (no phone yet)'}
                      </p>
                    </>
                  ) : (
                    <p className="m-0 mt-1 font-sans text-[13px] text-[#9a958c]">Not linked. Generate a code below.</p>
                  )}
                </div>
                {row ? (
                  <GhostButton onClick={() => onToggleUnlink(app)} disabled={unlinkBusy}>
                    {unlinking === app ? 'Cancel' : 'Unlink'}
                  </GhostButton>
                ) : null}
              </div>
              {row && unlinking === app ? (
                <ConfirmPassword
                  intro="Removes this chat and its phone proof from Flizy. Pending phone claims need that number proven again in chat to claim."
                  value={password}
                  onChange={onPassword}
                  onSubmit={() => onConfirmUnlink(app)}
                  onCancel={() => onToggleUnlink(app)}
                  busy={unlinkBusy}
                  confirmLabel={`Confirm unlink ${name}`}
                  busyLabel="Unlinking..."
                />
              ) : null}
            </div>
          );
        })}

        <InfoNote>
          In chat you can also send{' '}
          <code className="rounded-[6px] bg-[#1a1810] px-1.5 py-0.5 font-mono text-[12.5px] text-sun">flizy unlink</code> to
          disconnect that app.
        </InfoNote>

        <button
          type="button"
          onClick={onGenerate}
          disabled={generating}
          className="btn-sun relative mt-1 flex h-[54px] w-full items-center justify-center overflow-hidden rounded-[12px] font-sans text-[16px] font-semibold disabled:opacity-60"
        >
          <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_120%_at_10%_100%,rgba(255,255,255,0.35),transparent_55%)]" />
          <span className="relative">{generating ? 'Generating...' : code ? 'Generate a new code' : 'Generate code'}</span>
          <span className="absolute right-5" aria-hidden>
            <ChevronGlyph />
          </span>
        </button>

        {code ? (
          <div className="grid gap-3 rounded-[16px] border border-[#5a4a1f] bg-[linear-gradient(180deg,rgba(247,208,71,0.07),rgba(247,208,71,0.01))] p-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="m-0 font-mono text-[10.5px] font-medium uppercase tracking-[0.22em] text-[#d9c58a]">Your code</p>
                <p className="m-0 mt-1 font-mono text-[30px] font-semibold tracking-[0.18em] text-white">{code.code}</p>
              </div>
              <p className="m-0 pb-1.5 text-right font-sans text-[11.5px] text-[#9a958c]">
                Expires
                <br />
                {new Date(code.expiresAt).toLocaleString()}
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-[10px] border border-[#26262a] bg-[#0d0d0e] px-3.5 py-2.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-[#e9e4da]">flizy link {code.code}</code>
              <button
                type="button"
                onClick={() => void copyMessage()}
                className={`h-[32px] shrink-0 rounded-[8px] border px-3 font-sans text-[12.5px] ${
                  copied ? 'border-sun/70 text-sun' : 'border-[#3a3a3e] text-[#d9d4ca] hover:text-white'
                }`}
              >
                {copied ? 'Copied' : 'Copy message'}
              </button>
            </div>
            <div className={`grid gap-2.5 ${code.telegramDeepLink ? 'sm:grid-cols-2' : ''}`}>
              <a
                href={code.waDeepLink}
                target="_blank"
                rel="noreferrer"
                onClick={() => onStart('whatsapp')}
                className="flex h-[48px] items-center justify-center gap-2.5 rounded-[12px] border border-[#1d4a2a] bg-[#0f1c14] font-sans text-[14px] font-semibold text-white no-underline hover:border-[#2c6a3e]"
              >
                <img src="/account/tile-whatsapp.webp" alt="" aria-hidden className="h-[22px] w-[22px] rounded-[6px]" />
                Link WhatsApp
              </a>
              {code.telegramDeepLink ? (
                <a
                  href={code.telegramDeepLink}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => onStart('telegram')}
                  className="flex h-[48px] items-center justify-center gap-2.5 rounded-[12px] border border-[#4a3d1c] bg-[#17140b] font-sans text-[14px] font-semibold text-white no-underline hover:border-[#6a5628]"
                >
                  <img src="/account/tile-telegram.webp" alt="" aria-hidden className="h-[22px] w-[22px] rounded-[6px]" />
                  Link Telegram
                </a>
              ) : null}
            </div>
            {awaiting ? (
              <p className="m-0 flex items-center gap-2 font-sans text-[12.5px] text-[#b7b1a8]">
                <span className="h-[8px] w-[8px] animate-pulse rounded-full bg-sun motion-reduce:animate-none" aria-hidden />
                Waiting for {BRAND_NAME[awaiting]}. After you start the bot, this page will show connected.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Trusted wallets
// ---------------------------------------------------------------------------

export function TrustedPanel({
  fromChat,
  name,
  onName,
  address,
  onAddress,
  onSave,
  confirmingSave,
  onCancelSave,
  onConfirmSave,
  saving,
  saveError,
  saved,
  removing,
  onRemove,
  onCancelRemove,
  onConfirmRemove,
  removeBusy,
  removeError,
}: {
  /** The address came prefilled from a request in a chat app. */
  fromChat: boolean;
  name: string;
  onName: (value: string) => void;
  address: string;
  onAddress: (value: string) => void;
  /** The form was submitted with a name and a valid address: open the save sheet. */
  onSave: () => void;
  /** The save sheet is open. */
  confirmingSave: boolean;
  onCancelSave: () => void;
  /** Save with this password. */
  onConfirmSave: (password: string) => void;
  saving: boolean;
  /** Why the last save failed, shown in the save sheet. */
  saveError: string;
  saved: Array<{ address: string; label: string }>;
  /** Address whose delete sheet is open, if any. */
  removing: string | null;
  /** Open the delete sheet for this address. */
  onRemove: (address: string) => void;
  onCancelRemove: () => void;
  /** Delete with this password. */
  onConfirmRemove: (password: string) => void;
  removeBusy: boolean;
  /** Why the last delete failed, shown in the sheet. */
  removeError: string;
}) {
  const ids = useId();
  const [copied, setCopied] = useState<string | null>(null);
  const [addressProblem, setAddressProblem] = useState('');
  const cleanAddress = address.trim();

  async function copy(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(address);
      setTimeout(() => setCopied((c) => (c === address ? null : c)), 1600);
    } catch {
      setCopied(null);
    }
  }

  async function paste() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) onAddress(text);
    } catch {
      // Clipboard read refused: the field still takes a normal paste.
    }
  }

  return (
    <section className={PREF_CARD}>
      <PrefHero
        eyebrow="Trusted wallets"
        title="Add"
        accent="trusted wallet"
        text="Only these names can receive chat sends. This adds an extra layer of security to your account."
        art={<HeroArt src="/account/trusted-hero.webp" />}
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Caught here, before the password is asked for; the server checks again.
          if (!/^0x[0-9a-fA-F]{40}$/.test(cleanAddress)) {
            setAddressProblem('Use a full wallet address: 0x followed by 40 letters and numbers.');
            return;
          }
          setAddressProblem('');
          onSave();
        }}
        className="grid gap-4 px-4 pb-5 pt-2"
      >
        {fromChat ? (
          /*
           * Provenance, because the whole design rests on this moment.
           * Chat cannot add a destination, so the password in the save sheet
           * is the defence. A prefilled address with no explanation defeats
           * that: it reads as something the site chose, and the one plausible
           * attack left is getting somebody to authorise an address a chat
           * message put there. Name where it came from and ask them to
           * check it, here and again in the sheet.
           */
          <InfoNote tone="gold">
            This address came from a request in your chat app. Check it matches who you meant to pay before saving.
          </InfoNote>
        ) : null}

        <div className="grid gap-2">
          <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
          <label className={FIELD}>
            <span className="text-[#b7b1a8]">
              <PersonGlyph />
            </span>
            <input
              id={`${ids}-name`}
              className={FIELD_INPUT}
              placeholder="e.g. nald, mum, junior"
              value={name}
              onChange={(e) => onName(e.target.value)}
              required
            />
          </label>
        </div>

        <div className="grid gap-2">
          <FieldLabel htmlFor={`${ids}-address`}>Wallet address</FieldLabel>
          <label className={FIELD}>
            <span className="text-[#b7b1a8]">
              <LinkGlyph />
            </span>
            <input
              id={`${ids}-address`}
              className={`${FIELD_INPUT} font-mono text-[14px]`}
              placeholder="0x..."
              value={address}
              onChange={(e) => {
                onAddress(e.target.value);
                setAddressProblem('');
              }}
              aria-invalid={addressProblem ? true : undefined}
              aria-describedby={addressProblem ? `${ids}-address-problem` : undefined}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              required
            />
            <button
              type="button"
              onClick={() => void paste()}
              className="h-[32px] shrink-0 rounded-[8px] border border-[#3a3a3e] px-3 font-sans text-[12.5px] text-[#d9d4ca] hover:text-white"
            >
              Paste
            </button>
          </label>
          {addressProblem ? (
            <p id={`${ids}-address-problem`} className="m-0 font-sans text-[12.5px] text-[#f87171]">
              {addressProblem}
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          aria-haspopup="dialog"
          className="btn-sun h-[52px] w-full rounded-[12px] font-sans text-[16px] font-semibold"
        >
          Save trusted wallet
        </button>
      </form>

      <div className="mx-4 h-px bg-[#26262a]" />

      <div className="grid gap-3 px-4 pb-5 pt-5">
        <div className="flex items-center justify-between">
          <p className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[#d9d4ca]">Saved wallets</p>
          <span className="inline-flex h-[30px] min-w-[36px] items-center justify-center rounded-[8px] border border-[#5a4a1f] px-2.5 font-mono text-[13px] text-sun">
            {saved.length}
          </span>
        </div>

        {saved.length === 0 ? (
          <p className="m-0 rounded-[14px] border border-dashed border-[#2e2e33] px-4 py-5 text-center font-sans text-[13px] text-[#9a958c]">
            None yet. Save a wallet above and chat can send to it by name.
          </p>
        ) : (
          saved.map((t) => {
            const label = t.label || 'unnamed';
            return (
              <div
                key={t.address}
                className="flex gap-3.5 rounded-[16px] border border-[#4a3d1c] bg-[radial-gradient(120%_140%_at_100%_0%,rgba(247,208,71,0.08),rgba(15,15,16,0)_60%),#12100b] p-4"
              >
                <span
                  className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full bg-[#2a2210] font-sans text-[20px] font-bold text-sun"
                  aria-hidden
                >
                  {label.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate font-sans text-[16px] font-semibold text-white">{label}</p>
                  <p className="m-0 mt-0.5 break-all font-mono text-[12px] leading-[1.5] text-[#b7b1a8]">{t.address}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void copy(t.address)}
                      className={`inline-flex h-[38px] items-center gap-2 rounded-[10px] border px-3.5 font-sans text-[13px] ${
                        copied === t.address ? 'border-sun/70 text-sun' : 'border-[#3a3a3e] text-white hover:border-[#5a5a60]'
                      }`}
                    >
                      <CopyGlyph />
                      {copied === t.address ? 'Copied' : 'Copy address'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(t.address)}
                      aria-haspopup="dialog"
                      className="inline-flex h-[38px] items-center gap-2 rounded-[10px] border border-[#7a2a36] px-3.5 font-sans text-[13px] text-[#f87171] hover:border-[#a33a48]"
                    >
                      <TrashGlyph />
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}

      </div>

      {confirmingSave ? (
        <WalletPasswordSheet
          mode="save"
          wallet={{ address: cleanAddress, label: name.trim() }}
          fromChat={fromChat}
          busy={saving}
          error={saveError}
          onCancel={onCancelSave}
          onConfirm={onConfirmSave}
        />
      ) : null}

      {removing ? (
        <WalletPasswordSheet
          mode="delete"
          wallet={saved.find((t) => t.address === removing) ?? { address: removing, label: '' }}
          busy={removeBusy}
          error={removeError}
          onCancel={onCancelRemove}
          onConfirm={onConfirmRemove}
        />
      ) : null}
    </section>
  );
}

/**
 * The account-password step for a sensitive change: what is about to happen,
 * then the password, then the action. It holds its own password, so nothing
 * typed here outlives it. Portalled to body: inside the page it would sit
 * under the fixed bottom nav.
 */
export function PasswordSheet({
  tone,
  icon,
  title,
  text,
  children,
  confirmLabel,
  busyLabel,
  busy,
  error,
  onCancel,
  onConfirm,
  passwordLabel = 'Account password',
  passwordPlaceholder = 'Confirm it is you',
  focusPassword = true,
}: {
  tone: 'gold' | 'danger';
  icon: ReactNode;
  title: string;
  text: ReactNode;
  /** What the change is about, shown above the password. */
  children?: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  /** Why the last try was refused, if it was. */
  error: string;
  onCancel: () => void;
  onConfirm: (password: string) => void;
  passwordLabel?: string;
  passwordPlaceholder?: string;
  /** False when the content above has the field to start in. */
  focusPassword?: boolean;
}) {
  const [password, setPassword] = useState('');
  const titleId = useId();
  const gold = tone === 'gold';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-[2px] sm:items-center"
      role="presentation"
      onClick={() => !busy && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[440px] rounded-t-[20px] border border-b-0 border-[#3a2a1c] bg-[#101011] px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-4 shadow-[0_-20px_60px_rgba(0,0,0,0.6)] sm:rounded-[20px] sm:border-b"
      >
        <div className="mx-auto mb-4 h-[4px] w-[38px] rounded-full bg-[#2c2d33] sm:hidden" aria-hidden />
        <div className="flex items-start gap-3.5">
          <span
            className={`flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full border ${
              gold ? 'border-[#5a4a1f] bg-[#2a2210] text-sun' : 'border-[#6b2430] bg-[#2a1216] text-[#f87171]'
            }`}
          >
            {icon}
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="m-0 font-sans text-[18px] font-bold text-white">
              {title}
            </h2>
            <p className="m-0 mt-1 font-sans text-[13px] leading-[1.55] text-[#9a958c]">{text}</p>
          </div>
        </div>

        {children ? <div className="mt-4 grid gap-3">{children}</div> : null}

        <form
          className="mt-4 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (password && !busy) onConfirm(password);
          }}
        >
          <FieldLabel>{passwordLabel}</FieldLabel>
          <SecretInput value={password} onChange={setPassword} placeholder={passwordPlaceholder} label={passwordLabel} autoFocus={focusPassword} />
          {error ? (
            <p role="alert" className="m-0 rounded-[10px] border border-[#6b2430] bg-[#1a0f11] px-3 py-2 font-sans text-[13px] text-[#f87171]">
              {error}
            </p>
          ) : null}
          <div className="mt-1 grid grid-cols-2 gap-2.5">
            <GhostButton onClick={onCancel} disabled={busy} className="h-[50px] w-full">
              Cancel
            </GhostButton>
            <button
              type="submit"
              disabled={busy || !password}
              className={`h-[50px] rounded-[12px] font-sans text-[15px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                gold ? 'btn-sun' : 'bg-[#dc2626] text-white hover:bg-[#ef4444]'
              }`}
            >
              {busy ? busyLabel : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

/** Saving or deleting a trusted wallet: which wallet, then the password. */
function WalletPasswordSheet({
  mode,
  wallet,
  fromChat = false,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  mode: 'save' | 'delete';
  wallet: { address: string; label: string };
  /** Saving an address a chat request prefilled: say so here too, where the password is given. */
  fromChat?: boolean;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}) {
  const saving = mode === 'save';
  const label = <span className="font-semibold text-white">{wallet.label || 'unnamed'}</span>;
  return (
    <PasswordSheet
      tone={saving ? 'gold' : 'danger'}
      icon={saving ? <ShieldGlyph /> : <TrashGlyph />}
      title={saving ? 'Save trusted wallet' : 'Delete trusted wallet'}
      text={
        saving ? (
          <>Chat will be able to send to {label} at this address.</>
        ) : (
          <>Chat will no longer send to {label}. You can add it again later.</>
        )
      }
      confirmLabel={saving ? 'Save' : 'Delete'}
      busyLabel={saving ? 'Saving...' : 'Deleting...'}
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {saving && fromChat ? (
        <InfoNote tone="gold">This address came from a request in your chat app. Check it matches who you meant to pay before saving.</InfoNote>
      ) : null}
      <div className="rounded-[12px] border border-[#26262a] bg-[#0b0b0c] px-3.5 py-3">
        <p className="m-0 font-mono text-[10.5px] font-medium uppercase tracking-[0.22em] text-[#9a958c]">Wallet</p>
        <p className="m-0 mt-1 break-all font-mono text-[12.5px] leading-[1.5] text-[#e9e4da]">{wallet.address}</p>
      </div>
    </PasswordSheet>
  );
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

function svg(children: ReactNode, size = 20) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const LockGlyph = () => svg(<><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /><circle cx="12" cy="15.5" r="1" /></>);
export const PersonGlyph = () => svg(<><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5c1-4 4-6 7.5-6s6.5 2 7.5 6" /></>);
const LinkGlyph = () => svg(<><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></>);
const CopyGlyph = () => svg(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5h10" /></>, 16);
const TrashGlyph = () => svg(<><path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l1 13h9l1-13M9.5 7V4.5h5V7" /></>, 16);
export const ShieldGlyph = () => svg(<><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z" /><path d="M8.8 12.2l2.2 2.2 4.3-4.6" /></>);
export const ChevronGlyph = () => svg(<path d="M9 5.5l6.5 6.5L9 18.5" />, 22);

function EyeGlyph({ off }: { off: boolean }) {
  return svg(
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
      {off ? <path d="M4 4l16 16" /> : null}
    </>
  );
}
