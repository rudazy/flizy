/**
 * Web mirror of the display half of lib/sanitize.js.
 *
 * Kept byte-identical to the bot's displaySafeLabel, including the truncation
 * marker. The two disagreed once (U+2026 in chat, three dots on the web), so a
 * label over maxLength rendered differently depending on where you read it.
 * If you change one side, change both.
 */

// Same range as CONTROL_CHARS in lib/sanitize.js. A newline inside somebody
// else's label would otherwise let them forge an extra line on a screen that
// renders it, and a bidi control would let them reorder the line it is on.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/**
 * A label that came from somebody else, made safe to print.
 *
 * @param raw anything
 * @param maxLength cap before truncation
 * @returns empty string when there is nothing usable left
 */
export function displaySafeLabel(raw: unknown, maxLength = 40): string {
  const flat = String(raw ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}...` : flat;
}

/**
 * Whether a value someone is about to save holds any of the characters
 * displaySafeLabel strips. Used to refuse them at the door, so the stored
 * value is the one every screen shows.
 */
export function hasControlChars(raw: unknown): boolean {
  // A fresh non-global copy: test() on the shared /g regex would carry
  // lastIndex from one call into the next.
  return new RegExp(CONTROL_CHARS.source).test(String(raw ?? ''));
}
