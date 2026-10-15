/**
 * Tell the owner a GitHub, Discord or X account was just linked.
 *
 * Linking routes claims sent to that handle into this Flizy account, and a
 * session cookie is enough to start it, so the owner hears about it on every
 * linked chat and by email. Called only for a new link, not when an existing
 * one refreshes its handle.
 *
 * Never throws: the link has already happened.
 */

import { getSupabase } from './supabase';
import { notifyAllChannels } from './notifyChannels';
import { mailOwner, platformLinkedMail } from './securityNotice.ts';
import { siteOrigin } from './siteOrigin';

const NAMES: Record<string, string> = { github: 'GitHub', discord: 'Discord', x: 'X' };

export async function announcePlatformLink(
  accountId: string,
  platform: 'github' | 'discord' | 'x',
  handle: string | null
): Promise<void> {
  const site = siteOrigin();
  try {
    await notifyAllChannels(
      accountId,
      [
        `${NAMES[platform]} was just linked to your Flizy account.`,
        '',
        `If that was not you, unlink it and change your password: ${site}/dashboard/account?s=platforms`,
      ].join('\n')
    );
  } catch (err) {
    console.warn('[platform-link] chat notice failed:', err instanceof Error ? err.message : err);
  }
  await mailOwner(getSupabase(), accountId, platformLinkedMail(site, platform, handle, new Date()));
}
