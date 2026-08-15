/**
 * Remember which chat app the user just opened to spend a link code.
 * The Telegram/WhatsApp deep link leaves this tab; when they come back
 * (or land on /) we resume Account → Chat instead of the marketing home.
 */

const KEY = 'flizy_await_chat';
const TTL_MS = 15 * 60 * 1000;

export type ChatLinkChannel = 'telegram' | 'whatsapp';

export function markAwaitingChatLink(channel: ChatLinkChannel): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ channel, at: Date.now() }));
  } catch {
    /* private mode / blocked storage */
  }
}

export function peekAwaitingChatLink(): ChatLinkChannel | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { channel?: string; at?: number };
    if (parsed.channel !== 'telegram' && parsed.channel !== 'whatsapp') {
      sessionStorage.removeItem(KEY);
      return null;
    }
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > TTL_MS) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return parsed.channel;
  } catch {
    return null;
  }
}

export function clearAwaitingChatLink(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
