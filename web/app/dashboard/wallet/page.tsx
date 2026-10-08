'use client';

import { AppTopBar } from '../../../components/AppTopBar';
import {
  AppPage,
  AppSlideNav,
  useSlide,
} from '../../../components/AppSection';
import { ActivityPanels } from '../../../components/ActivityPanels';
import { useDashboard } from '../../../components/DashboardProvider';
import { WalletBalances } from '../../../components/WalletBalances';
import { WalletScan } from '../../../components/WalletScan';
import { FaucetPanel } from '../../../components/FaucetPanel';
import { HistoryIcon, PlusCircleIcon, ScanIcon, WalletIcon } from '../../../components/ExploreIcons';

/**
 * Balances, History, Fund, Scan. History sits second because it is this
 * account's day-grouped list. Scan is every Flizy account, over a range.
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

      {slide === 'fund' ? <FaucetPanel /> : null}

      {slide === 'scan' ? <WalletScan /> : null}
    </AppPage>
  );
}
