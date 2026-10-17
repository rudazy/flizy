'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  PrivyProvider,
  useGuestAccounts,
  usePrivy,
  type PrivyClientConfig,
} from '@privy-io/react-auth';
import { defineChain } from 'viem';
import {
  CUSTODY_DOOR_CHAIN,
  CUSTODY_DOOR_COPY,
  custodyDoorAppId,
  custodyDoorIsGuest,
  passwordLoginHref,
} from '../lib/custodyDoor';

/**
 * Browser login only. Passkey, email, and Google are the account path.
 * Continue as guest creates a Privy guest on this device. It does not connect
 * an external wallet, open a Flizy session, send a transaction, or call a
 * server wallet.
 */

const giwaSepolia = defineChain({
  id: CUSTODY_DOOR_CHAIN.id,
  name: CUSTODY_DOOR_CHAIN.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [CUSTODY_DOOR_CHAIN.rpcUrl] } },
  blockExplorers: {
    default: { name: 'GIWA Explorer', url: CUSTODY_DOOR_CHAIN.explorerUrl },
  },
});

const privyConfig: PrivyClientConfig = {
  loginMethods: ['passkey', 'email', 'google'],
  defaultChain: giwaSepolia,
  supportedChains: [giwaSepolia],
  embeddedWallets: {
    ethereum: { createOnLogin: 'users-without-wallets' },
  },
  appearance: {
    theme: 'dark',
    accentColor: '#f7d043',
    landingHeader: CUSTODY_DOOR_COPY.modalHeader,
    loginMessage: CUSTODY_DOOR_COPY.modalMessage,
  },
  legal: {
    termsAndConditionsUrl: 'https://flizy.app/terms',
    privacyPolicyUrl: 'https://flizy.app/privacy',
  },
};

function DoorPanel({ next }: { next?: string }) {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { createGuestAccount } = useGuestAccounts();
  const copy = CUSTODY_DOOR_COPY;
  const [guestError, setGuestError] = useState('');
  const [guestBusy, setGuestBusy] = useState(false);
  const guest = custodyDoorIsGuest(user);

  async function onGuest() {
    if (!ready || guestBusy) return;
    setGuestError('');
    setGuestBusy(true);
    try {
      await createGuestAccount();
    } catch {
      setGuestError(copy.guestUnavailable);
    } finally {
      setGuestBusy(false);
    }
  }

  return (
    <div className="fade-up mx-auto max-w-md">
      <p className="text-xs uppercase tracking-[0.18em] text-gold">{copy.kicker}</p>
      <h1 className="mt-3 font-sans text-3xl tracking-wide text-paper">{copy.title}</h1>
      <p className="mt-2 text-sm text-muted">{copy.blurb}</p>
      <div className="card mt-8 space-y-5 p-6 md:p-8">
        {guest ? (
          <div role="status" className="space-y-4">
            <p className="font-sans text-lg tracking-wide text-paper">{copy.guestTitle}</p>
            <p className="text-sm text-muted">{copy.guestBody}</p>
            <button className="btn btn-primary w-full" type="button" onClick={() => login()}>
              {copy.guestUpgrade}
            </button>
            <p className="text-sm text-muted">{copy.guestUpgradeNote}</p>
            <button className="btn btn-ghost w-full text-sm" type="button" onClick={() => logout()}>
              {copy.guestLeave}
            </button>
          </div>
        ) : authenticated ? (
          <div role="status">
            <p className="font-sans text-lg tracking-wide text-paper">{copy.signedInTitle}</p>
            <p className="mt-2 text-sm text-muted">{copy.signedInBody}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <button
              className="btn btn-primary w-full"
              type="button"
              onClick={() => login({ loginMethods: ['passkey'] })}
              disabled={!ready}
            >
              {ready ? copy.passkey : copy.waiting}
            </button>
            <button
              className="btn btn-ghost w-full"
              type="button"
              onClick={() => login({ loginMethods: ['email'] })}
              disabled={!ready}
            >
              {copy.email}
            </button>
            <button
              className="btn btn-ghost w-full"
              type="button"
              onClick={() => login({ loginMethods: ['google'] })}
              disabled={!ready}
            >
              {copy.google}
            </button>
            <button
              className="btn btn-ghost w-full"
              type="button"
              onClick={onGuest}
              disabled={!ready || guestBusy}
            >
              {guestBusy ? copy.guestBusy : copy.guest}
            </button>
            {guestError ? (
              <p className="text-sm text-muted" role="alert">
                {guestError}
              </p>
            ) : null}
          </div>
        )}
        <p className="text-center text-sm text-muted">
          <Link href={passwordLoginHref(next)} className="text-lime no-underline hover:text-gold">
            {copy.password}
          </Link>
        </p>
      </div>
    </div>
  );
}

export function CustodyDoor({ next }: { next?: string }) {
  const appId = custodyDoorAppId();
  if (!appId) return null;
  return (
    <PrivyProvider appId={appId} config={privyConfig}>
      <DoorPanel next={next} />
    </PrivyProvider>
  );
}
