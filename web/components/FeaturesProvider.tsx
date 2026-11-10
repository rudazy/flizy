'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { FeatureFlags } from '../lib/features.ts';

/**
 * The paused-feature switches, read on the server by the root layout
 * (web/lib/features.ts) and handed down here so client navigation can hide
 * what is paused. Hiding is only the surface: the routes refuse new activity
 * on their own, whatever the browser shows.
 */

const ALL_OFF: FeatureFlags = { nftMarket: false, nftMint: false, tasks: false, projects: false, tokenSocial: false, follows: false };

const FeaturesContext = createContext<FeatureFlags>(ALL_OFF);

export function FeaturesProvider({ flags, children }: { flags: FeatureFlags; children: ReactNode }) {
  return <FeaturesContext.Provider value={flags}>{children}</FeaturesContext.Provider>;
}

export function useFeatures(): FeatureFlags {
  return useContext(FeaturesContext);
}
