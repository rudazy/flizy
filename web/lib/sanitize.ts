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
// renders it.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

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
