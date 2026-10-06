'use client';

import { AppTopBar } from '../../../components/AppTopBar';
import {
  AppPage,
  AppSection,
  AppSlideNav,
  useSlide,
} from '../../../components/AppSection';
import { ActivityPanels } from '../../../components/ActivityPanels';
import { CopyButton } from '../../../components/CopyButton';
import { useDashboard } from '../../../components/DashboardProvider';
import { WalletBalances } from '../../../components/WalletBalances';
import { WalletScan } from '../../../components/WalletScan';
import { HistoryIcon, PlusCircleIcon, ScanIcon, WalletIcon } from '../../../components/ExploreIcons';

/**
 * Balances, History, Fund, Scan. History sits second because it is the
 * day-grouped list. Scan is the range and the totals over the same activity.
 */
const SLIDES = ['balances', 'history', 'fund', 'scan'] as const;

export default function WalletPage() {
  const { data, refreshing, refreshAll } = useDashboard();
  const [slide, setSlide] = useSlide(SLIDES, 'balances');

  if (!data) return null;

  const nav = [
    { id: 'balances', label: 'Balances', icon: <WalletIcon size={15} /> },
    { id: 'history', label: 'History', icon: <HistoryIcon size={15} /> },
    { id: 'fund', label: 'Fund', icon: <PlusCircleIcon size={15} /> },
    { id: 'scan', label: 'Scan', icon: <ScanIcon size={15} /> },
  ];

  return (
    <AppPage>
      <AppTopBar
        title="Wallet"
        actionLabel="Refresh"
        onAction={refreshAll}
        actionBusy={refreshing}
      />

      {/* The top bar keeps its own bottom margin; the tabs sit closer under it here. */}
      <div className="!-mt-[15px]">
        <AppSlideNav items={nav} activeId={slide} onSelect={setSlide} variant="tabs" />
      </div>

      {slide === 'balances' ? <WalletBalances /> : null}

      {/*
        The same panels the History tab renders, from one component, so the two
        surfaces cannot drift. No Wallet link in the empty state here: it would
        point at the page already on screen.
      */}
      {slide === 'history' ? <ActivityPanels showWalletLink={false} /> : null}

      {slide === 'fund' ? (
        <AppSection
          title="Fund"
          helper="Copy your Flizy wallet address, open the official GIWA faucet, paste it, and request test ETH."
        >
          {data.account.agent_wallet_address ? (
            <div className="mb-5">
              <p className="label">Your Flizy wallet (paste this on the faucet)</p>
              <p className="mono-box mt-1 break-all text-sm">{data.account.agent_wallet_address}</p>
              <div className="mt-2">
                <CopyButton value={data.account.agent_wallet_address} label="Copy address" />
              </div>
            </div>
          ) : null}
          <ol className="space-y-3">
            {[
              {
                n: '1',
                t: 'Copy your Flizy wallet address',
                d: 'Use the address above — that is the wallet chat sends leave from.',
              },
              {
                n: '2',
                t: 'Open the official GIWA faucet',
                d: 'Go to faucet.giwa.io (official GIWA testnet faucet).',
                href: 'https://faucet.giwa.io',
                linkLabel: 'Open faucet.giwa.io',
              },
              {
                n: '3',
                t: 'Paste and request funds',
                d: 'Paste your Flizy wallet address on the faucet and claim test ETH. No bridge step.',
                href: 'https://faucet.giwa.io',
                linkLabel: 'Request on faucet',
              },
            ].map((step) => (
              <li
                key={step.n}
                className="flex gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border bg-ink font-mono text-[11px] text-lime">
                  {step.n}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-sans text-sm tracking-wide text-paper">{step.t}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{step.d}</p>
                  {'href' in step && step.href ? (
                    <a
                      href={step.href}
                      className="mt-2 inline-block text-xs text-lime no-underline hover:text-gold"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {step.linkLabel} →
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs leading-relaxed text-muted">
            Any token sent to this address is a deposit. Add its contract on Balances so it shows in the wallet.
            Only a verified token can be sent on socials. Any token in the wallet can be traded.
          </p>
        </AppSection>
      ) : null}

      {slide === 'scan' ? <WalletScan /> : null}
    </AppPage>
  );
}
