'use client';

import { useEffect } from 'react';
import { peekAwaitingChatLink } from '../lib/chatLinkAwait.ts';

/**
 * If the user opened WhatsApp/Telegram to link, then bounced to the
 * marketing home (common after t.me replaces the tab), send them back
 * to Account → Chat instead of leaving them on /.
 */
export function ResumeChatLink() {
  useEffect(() => {
    const awaiting = peekAwaitingChatLink();
    if (!awaiting) return;
    window.location.replace(`/dashboard/account?s=chat`);
  }, []);
  return null;
}
