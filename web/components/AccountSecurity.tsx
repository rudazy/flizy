'use client';

import { useState, type ReactNode } from 'react';
import { validatePassword } from '../lib/passwordPolicy';
import { HeroArt, PREF_CARD, PrefHero } from './AccountPrefs';
import {
  ChevronGlyph,
  FieldLabel,
  InfoNote,
  LockGlyph,
  PasswordSheet,
  PersonGlyph,
  SecretInput,
  ShieldGlyph,
} from './AccountConnections';

/**
 * Account PIN, Limits and Security slides. The page keeps the requests; these
 * draw them and check input before anything is sent.
 */

const PIN = /^\d{4,12}$/;

// ---------------------------------------------------------------------------
// PIN
// ---------------------------------------------------------------------------

export function PinPanel({
  hasPin,
  onSave,
  busy,
  lastError,
}: {
  hasPin: boolean;
  /** Save the PIN with the account password. True when it was saved. */
  onSave: (pin: string, password: string) => Promise<boolean>;
  busy: boolean;
  /** The page notice, shown in the sheet only after a refused try. */
  lastError: string;
}) {
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [problem, setProblem] = useState('');
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState(false);
  const verb = hasPin ? 'Update' : 'Set';

  function check() {
    if (!PIN.test(pin)) return 'Use 4 to 12 digits.';
    if (again !== pin) return 'The two PINs do not match.';
    return '';
  }

  async function confirm(password: string) {
    setRefused(false);
    const ok = await onSave(pin, password);
    if (ok) {
      setAsking(false);
      setPin('');
      setAgain('');
    } else {
      setRefused(true);
    }
  }

  return (
    <section className={PREF_CARD}>
      <PrefHero
        icon={<LockGlyph />}
        eyebrow="Security"
        title={`${verb} your`}
        accent="PIN"
        text="Your PIN locks and unlocks Flizy in chat (flizy lock, flizy unlock). Chat takes this PIN, never your password. Choose 4 to 12 digits and never share it."
        art={<HeroArt src="/account/pin-hero.webp" />}
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const why = check();
          setProblem(why);
          if (!why) {
            setRefused(false);
            setAsking(true);
          }
        }}
        className="grid gap-4 px-4 pb-5 pt-2"
      >
        <div className="grid gap-4 rounded-[16px] border border-[#26262a] bg-[#0f0f10] p-4">
          <PinField label="New PIN" placeholder="Enter 4 to 12 digits" value={pin} onChange={(v) => { setPin(v); setProblem(''); }} />
          <PinField label="Confirm PIN" placeholder="Re-enter your PIN" value={again} onChange={(v) => { setAgain(v); setProblem(''); }} />
          {problem ? <p role="alert" className="m-0 font-sans text-[13px] text-[#f87171]">{problem}</p> : null}
        </div>

        <InfoNote tone="gold">
          For your safety, do not use easily guessed numbers like your birth year, phone number or repeating digits.
        </InfoNote>

        <button
          type="submit"
          aria-haspopup="dialog"
          className="btn-sun relative flex h-[54px] w-full items-center justify-center rounded-[12px] font-sans text-[16px] font-semibold"
        >
          {verb} PIN
          <span className="absolute right-5" aria-hidden>
            <ArrowGlyph />
          </span>
        </button>
        {hasPin ? (
          <p className="m-0 text-center font-sans text-[12px] text-[#9a958c]">You have a PIN. Saving a new one replaces it.</p>
        ) : null}
      </form>

      {asking ? (
        <PasswordSheet
          tone="gold"
          icon={<LockGlyph />}
          title={`${verb} your PIN`}
          text="Confirm it is you. The new PIN works in chat as soon as it is saved."
          confirmLabel={`${verb} PIN`}
          busyLabel="Saving..."
          busy={busy}
          error={refused ? lastError : ''}
          onCancel={() => setAsking(false)}
          onConfirm={(pw) => void confirm(pw)}
        />
      ) : null}
    </section>
  );
}

function PinField({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (v: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="grid gap-2">
      <FieldLabel>{label}</FieldLabel>
      <label className="flex min-h-[54px] w-full items-center gap-3 rounded-[12px] border border-[#2e2e33] bg-[#0b0b0c] px-4 transition-colors focus-within:border-sun/70">
        <span className="text-[#d9d4ca]">
          <KeypadGlyph />
        </span>
        <input
          type={shown ? 'text' : 'password'}
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={12}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
          aria-label={label}
          className="min-w-0 flex-1 bg-transparent font-mono text-[16px] tracking-[0.2em] text-white outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-[#6f6a62]"
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-pressed={shown}
          aria-label={shown ? `Hide ${label}` : `Show ${label}`}
          className="hit-44 flex h-[32px] w-[32px] items-center justify-center text-[#b7b1a8] hover:text-white"
        >
          <EyeGlyph off={shown} />
        </button>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export function LimitsPanel({
  current,
  onSave,
  busy,
  lastError,
}: {
  /** "0.5 ETH / UTC day" or "App default". */
  current: string;
  /** Save the limit (null clears it) with the account password. True when saved. */
  onSave: (limit: number | null, password: string) => Promise<boolean>;
  busy: boolean;
  /** The page notice, shown in the sheet only after a refused try. */
  lastError: string;
}) {
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState('');
  const [policy, setPolicy] = useState(false);
  /** The checked limit waiting for the password; undefined while no sheet is open. */
  const [pending, setPending] = useState<number | null | undefined>(undefined);
  const [refused, setRefused] = useState(false);

  async function confirm(password: string) {
    if (pending === undefined) return;
    setRefused(false);
    const ok = await onSave(pending, password);
    if (ok) {
      setPending(undefined);
      setValue('');
    } else {
      setRefused(true);
    }
  }
  const [amount, unit] = current.includes(' / ') ? current.split(' / ') : [current, ''];

  return (
    <section className={PREF_CARD}>
      <PrefHero
        icon={<BarsGlyph />}
        eyebrow="Spending limits"
        title="Daily ETH"
        accent="send limit"
        text="Set a daily limit for ETH sends from your account. This helps protect your funds. 0 blocks every ETH send."
        art={<HeroArt src="/account/limits-hero.webp" />}
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const raw = value.trim();
          const limit = raw === '' ? null : Number(raw);
          if (raw !== '' && (!/^(\d+(\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(limit))) {
            setProblem('Enter a number like 0.05, or leave it empty for no limit.');
            return;
          }
          setProblem('');
          setRefused(false);
          setPending(limit);
        }}
        className="grid gap-4 px-4 pb-5 pt-2"
      >
        <div className="rounded-[16px] border border-[#4a3d1c] bg-[radial-gradient(120%_140%_at_100%_0%,rgba(247,208,71,0.10),rgba(15,15,16,0)_60%),#12100b] p-4">
          <div className="flex items-center gap-4">
            <span className="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-[12px] bg-[#2a2210] text-sun" aria-hidden>
              <WalletGlyph />
            </span>
            <div className="min-w-0 flex-1">
              <p className="m-0 font-sans text-[13px] text-[#b7b1a8]">Current limit</p>
              <p className="m-0 mt-0.5 font-sans text-[20px] font-bold text-white">
                {amount}
                {unit ? <span className="font-medium text-[#d9d4ca]"> / {unit}</span> : null}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPolicy((o) => !o)}
              aria-expanded={policy}
              className="h-[40px] shrink-0 rounded-[10px] border border-[#5a4a1f] px-4 font-sans text-[14px] font-medium text-sun hover:border-sun/70"
            >
              Policy
            </button>
          </div>
          {policy ? (
            <ul className="m-0 mt-4 grid list-none gap-1.5 border-t border-white/[0.06] p-0 pt-3 font-sans text-[13px] leading-[1.55] text-[#d9d4ca]">
              <li>Counts ETH you send from Flizy, in chat and on the site, including claims you hold for someone.</li>
              <li>Swaps do not count: the value stays in your wallet.</li>
              <li>The day resets at 00:00 UTC.</li>
              <li>Empty means no limit of your own; 0 blocks every ETH send.</li>
            </ul>
          ) : null}
        </div>

        <div className="grid gap-2">
          <FieldLabel>Limit (ETH / day)</FieldLabel>
          <label className="flex min-h-[56px] w-full items-stretch overflow-hidden rounded-[12px] border border-[#2e2e33] bg-[#0d0d0e] transition-colors focus-within:border-sun/70">
            <span className="flex w-[56px] shrink-0 items-center justify-center border-r border-[#26262a] text-[#d9d4ca]" aria-hidden>
              <EthGlyph />
            </span>
            <input
              inputMode="decimal"
              placeholder="e.g. 0.05"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setProblem('');
              }}
              aria-label="Limit in ETH per day"
              className="min-w-0 flex-1 bg-transparent px-4 font-sans text-[16px] text-white outline-none placeholder:text-[#6f6a62]"
            />
            <span className="flex shrink-0 items-center border-l border-[#26262a] px-4 font-sans text-[14px] text-[#b7b1a8]">ETH</span>
          </label>
          {problem ? (
            <p role="alert" className="m-0 font-sans text-[13px] text-[#f87171]">{problem}</p>
          ) : (
            <p className="m-0 flex items-center gap-2 font-sans text-[12.5px] text-[#9a958c]">
              <InfoGlyph /> Leave empty for no limit.
            </p>
          )}
        </div>

        <button
          type="submit"
          aria-haspopup="dialog"
          className="btn-sun relative flex h-[54px] w-full items-center justify-center rounded-[12px] font-sans text-[16px] font-semibold"
        >
          Save daily limit
          <span className="absolute right-5" aria-hidden>
            <ArrowGlyph />
          </span>
        </button>
      </form>

      {pending !== undefined ? (
        <PasswordSheet
          tone="gold"
          icon={<BarsGlyph />}
          title="Save daily limit"
          text={
            pending === null ? (
              <>Your own limit is removed. The app default applies.</>
            ) : pending === 0 ? (
              <>
                Your limit becomes <span className="font-semibold text-white">0 ETH</span>: every ETH send is blocked.
              </>
            ) : (
              <>
                Your limit becomes <span className="font-semibold text-white">{pending} ETH</span> per UTC day.
              </>
            )
          }
          confirmLabel="Save limit"
          busyLabel="Saving..."
          busy={busy}
          error={refused ? lastError : ''}
          onCancel={() => setPending(undefined)}
          onConfirm={(pw) => void confirm(pw)}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export function SecurityPanel({
  email,
  emailVerified,
  onChangeEmail,
  onChangePassword,
  changingPassword,
  onSignOut,
  signingOut,
}: {
  email: string | null;
  emailVerified: boolean;
  onChangeEmail: () => void;
  /** Change the password. Resolves to the reason when refused, null when changed. */
  onChangePassword: (current: string, next: string) => Promise<string | null>;
  changingPassword: boolean;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [changing, setChanging] = useState(false);
  return (
    <section className={PREF_CARD}>
      <PrefHero
        eyebrow="Security"
        title="Keep your account"
        accent="safe"
        text="Manage your security settings and review what protects your account."
        art={<HeroArt src="/account/security-hero.webp" />}
      />

      <div className="grid gap-5 px-4 pb-5 pt-2">
        <div className="flex items-center gap-4 rounded-[16px] border border-[#2e2e33] bg-[#0f0f10] p-4">
          <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full bg-[#2a2210] text-sun" aria-hidden>
            <PersonGlyph />
          </span>
          <div className="min-w-0 flex-1">
            <p className="m-0 font-sans text-[13px] text-[#9a958c]">Signed in as</p>
            <p className="m-0 mt-0.5 break-all font-sans text-[16px] font-semibold text-white">
              {email || 'No email on this account'}
            </p>
            {email ? (
              <span
                className={`mt-1.5 inline-flex h-[24px] items-center gap-1.5 rounded-full border px-2.5 font-sans text-[12px] ${
                  emailVerified ? 'border-[#1f4a2c] bg-[#0f2a18] text-[#4ade80]' : 'border-[#5a4a1f] bg-[#16130b] text-sun'
                }`}
              >
                <span className={`h-[7px] w-[7px] rounded-full ${emailVerified ? 'bg-[#4ade80]' : 'bg-sun'}`} aria-hidden />
                {emailVerified ? 'Verified' : 'Not verified'}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onChangeEmail}
            className="inline-flex h-[42px] shrink-0 items-center gap-1 rounded-[10px] border border-[#5a4a1f] px-3.5 font-sans text-[14px] font-medium text-sun hover:border-sun/70"
          >
            {email ? 'Change email' : 'Add email'}
          </button>
        </div>

        <div className="grid gap-2.5">
          <SectionLabel>Security settings</SectionLabel>
          <SettingRow
            icon={<LockGlyph />}
            title="Account password"
            text="Approves trusted wallets, limits, your PIN and other sensitive changes."
            action={
              <button
                type="button"
                onClick={() => setChanging(true)}
                aria-haspopup="dialog"
                className="inline-flex h-[42px] shrink-0 items-center rounded-[10px] border border-[#5a4a1f] px-4 font-sans text-[14px] font-medium text-sun hover:border-sun/70"
              >
                Change
              </button>
            }
          />
          <SettingRow icon={<ShieldGlyph />} title="Two-step verification" text="An extra check when you sign in." status="Not available yet" muted />
          <SettingRow icon={<ScreenGlyph />} title="Active sessions" text="See and sign out other devices." status="Not available yet" muted />
        </div>

        <div className="grid gap-2.5">
          <SectionLabel>Legal</SectionLabel>
          {/*
            The signed-in app has no footer (AppChrome returns early for
            /dashboard), so without these the only copy of the agreement a user
            accepted is unreachable from inside the product.
          */}
          <div className="grid gap-2.5 sm:grid-cols-3">
            <LegalCard href="/docs" icon={<DocGlyph />} title="Security docs" text="Learn how we keep your assets safe." />
            <LegalCard href="/terms" icon={<ListGlyph />} title="Terms of service" text="Rules for using Flizy." />
            <LegalCard href="/privacy" icon={<ShieldGlyph />} title="Privacy policy" text="How we protect your data." />
          </div>
        </div>

        <div className="grid gap-2.5">
          <p className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[#f87171]">Danger zone</p>
          <button
            type="button"
            onClick={onSignOut}
            disabled={signingOut}
            className="flex min-h-[68px] w-full items-center gap-4 rounded-[16px] border border-[#6b2430] bg-[linear-gradient(90deg,rgba(220,38,38,0.12),rgba(220,38,38,0.02))] px-4 py-3 text-left hover:border-[#8a2f3c] disabled:opacity-60"
          >
            <span className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[12px] bg-[#2a1216] text-[#f87171]" aria-hidden>
              <SignOutGlyph />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-sans text-[16px] font-semibold text-white">{signingOut ? 'Signing out...' : 'Sign out'}</span>
              <span className="mt-0.5 block font-sans text-[13px] text-[#b7b1a8]">Sign out from this device.</span>
            </span>
            <span className="text-[#f87171]" aria-hidden>
              <ChevronGlyph />
            </span>
          </button>
        </div>
      </div>

      {changing ? (
        <ChangePasswordSheet busy={changingPassword} onCancel={() => setChanging(false)} onChange={onChangePassword} onDone={() => setChanging(false)} />
      ) : null}
    </section>
  );
}

const RULES: Array<{ label: string; test: (p: string) => boolean }> = [
  { label: '8 or more characters', test: (p) => p.length >= 8 },
  { label: 'A letter', test: (p) => /[a-zA-Z]/.test(p) },
  { label: 'A number', test: (p) => /[0-9]/.test(p) },
  { label: 'A special character, like !@#$%', test: (p) => /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(p) },
];

/**
 * New password twice, then the current one. The new one is checked against
 * the signup rules here and again on the server.
 */
function ChangePasswordSheet({
  busy,
  onCancel,
  onChange,
  onDone,
}: {
  busy: boolean;
  onCancel: () => void;
  onChange: (current: string, next: string) => Promise<string | null>;
  onDone: () => void;
}) {
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');

  async function confirm(current: string) {
    const rule = validatePassword(next);
    if (!rule.ok) return setError(rule.error);
    if (again !== next) return setError('The two new passwords do not match.');
    if (current === next) return setError('Choose a new password, not the one you use now.');
    setError('');
    const refused = await onChange(current, next);
    if (refused) setError(refused);
    else onDone();
  }

  return (
    <PasswordSheet
      tone="gold"
      icon={<LockGlyph />}
      title="Change password"
      text="Other devices are signed out when it changes. This one stays signed in."
      confirmLabel="Change password"
      busyLabel="Changing..."
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={(current) => void confirm(current)}
      passwordLabel="Current password"
      passwordPlaceholder="The password you use now"
      focusPassword={false}
    >
      <div className="grid gap-2">
        <FieldLabel>New password</FieldLabel>
        <SecretInput value={next} onChange={(v) => { setNext(v); setError(''); }} placeholder="Choose a new password" autoComplete="new-password" label="New password" autoFocus />
      </div>
      <ul className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0 font-sans text-[12px]" aria-label="Password rules">
        {RULES.map((r) => {
          const met = r.test(next);
          return (
            <li key={r.label} className={`flex items-center gap-1.5 ${met ? 'text-[#4ade80]' : 'text-[#8f8a82]'}`}>
              <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${met ? 'bg-[#4ade80]' : 'bg-[#4a4a50]'}`} aria-hidden />
              {r.label}
            </li>
          );
        })}
      </ul>
      <div className="grid gap-2">
        <FieldLabel>Confirm new password</FieldLabel>
        <SecretInput value={again} onChange={(v) => { setAgain(v); setError(''); }} placeholder="Type it again" autoComplete="new-password" label="Confirm new password" />
      </div>
    </PasswordSheet>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[#b7b1a8]">{children}</p>;
}

/** A setting: its state, and its control when one exists. */
function SettingRow({
  icon,
  title,
  text,
  status,
  action,
  muted = false,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  status?: string;
  /** A real control for this setting, when one exists. */
  action?: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-4 rounded-[16px] border border-[#26262a] bg-[#0f0f10] p-4">
      <span className={`flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[12px] ${muted ? 'bg-[#18181a] text-[#9a958c]' : 'bg-[#2a2210] text-sun'}`} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 font-sans text-[15.5px] font-semibold text-white">{title}</p>
        <p className="m-0 mt-0.5 font-sans text-[13px] leading-[1.5] text-[#9a958c]">{text}</p>
      </div>
      {status ? (
        <span
          className={`shrink-0 rounded-full px-3 py-1 font-sans text-[12px] ${
            muted ? 'bg-[#1d1d20] text-[#9a958c]' : 'border border-[#1f4a2c] bg-[#0f2a18] text-[#4ade80]'
          }`}
        >
          {status}
        </span>
      ) : null}
      {action}
    </div>
  );
}

function LegalCard({ href, icon, title, text }: { href: string; icon: ReactNode; title: string; text: string }) {
  return (
    <a
      href={href}
      className="flex min-h-[64px] items-center gap-3 rounded-[16px] border border-[#26262a] bg-[#0f0f10] p-4 no-underline transition-colors hover:border-[#3a3a3e] sm:block"
    >
      <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] bg-[#1d1d20] text-[#d9d4ca]" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 sm:mt-3 sm:block">
        <span className="flex items-center justify-between gap-2 font-sans text-[15px] font-semibold text-white">
          {title}
          <span className="text-[#9a958c]" aria-hidden>
            <ChevronGlyph />
          </span>
        </span>
        <span className="mt-0.5 block font-sans text-[13px] leading-[1.5] text-[#9a958c]">{text}</span>
      </span>
    </a>
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

const KeypadGlyph = () =>
  svg(
    <>
      {[6, 12, 18].flatMap((y) => [6, 12, 18].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" fill="currentColor" stroke="none" />))}
    </>
  );
const ArrowGlyph = () => svg(<path d="M5 12h14M13 6l6 6-6 6" />, 22);
const BarsGlyph = () => svg(<path d="M6 19v-6M10 19V9M14 19v-9M18 19V5" />);
const WalletGlyph = () => svg(<><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" /><path d="M8 6V4.5h8V6M15.5 13h1.5" /></>, 22);
const EthGlyph = () => svg(<><path d="M12 3l6 9-6 3.5L6 12z" /><path d="M6 13.5l6 7.5 6-7.5-6 3.5z" /></>, 22);
const InfoGlyph = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>, 16);
const ScreenGlyph = () => svg(<><rect x="3.5" y="4.5" width="17" height="11.5" rx="2" /><path d="M9 20h6M12 16v4" /></>);
const DocGlyph = () => svg(<><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z" /><path d="M14 3.5V8h4M9.5 12.5h5M9.5 16h5" /></>);
const ListGlyph = () => svg(<><rect x="5" y="3.5" width="14" height="17" rx="2" /><path d="M9 8.5h6M9 12h6M9 15.5h4" /></>);
const SignOutGlyph = () => svg(<><path d="M14 4.5H6.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1H14" /><path d="M10.5 12H20M16.5 8l3.5 4-3.5 4" /></>, 22);

function EyeGlyph({ off }: { off: boolean }) {
  return svg(
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
      {off ? <path d="M4 4l16 16" /> : null}
    </>
  );
}
