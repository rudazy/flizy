'use client';

import { useLayoutEffect } from 'react';
import { DEFAULT_APPEARANCE } from '../lib/appearance';
import { applyAppearance, writeAppearanceCache } from '../lib/appearanceCache';
import { useDashboard } from './DashboardProvider';

/**
 * Reconcile the fixed background layer with the account row.
 * The layer itself lives in the dashboard layout, as a sibling of the shell.
 */
export function AppBackgroundSync() {
  const { data } = useDashboard();
  const appearance = data?.appearance ?? null;

  useLayoutEffect(() => {
    if (!appearance) return;
    const next = appearance.mode ? appearance : DEFAULT_APPEARANCE;
    writeAppearanceCache(next);
    applyAppearance(next);
  }, [appearance]);

  useLayoutEffect(() => {
    return () => {
      applyAppearance(DEFAULT_APPEARANCE);
    };
  }, []);

  return null;
}
