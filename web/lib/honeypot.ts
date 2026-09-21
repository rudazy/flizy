/**
 * Honeypot field for public forms.
 *
 * A field a person never sees and never fills, rendered as a real input so a
 * form-filling bot finds it and completes it. Anything that arrives with it set
 * did not come from the form.
 *
 * This catches the cheap end of the traffic only. It is a filter in front of
 * the rate limit, not a replacement for it: a bot written against this specific
 * form skips the field and is stopped by the cap instead.
 *
 * The name lives here rather than in the form so the input and the check cannot
 * drift apart. Rename it and both sides move together; rename it in one place
 * only and every real submission starts failing, which is the loud direction
 * for that mistake to break in.
 */

/**
 * Chosen for what browsers will NOT do with it, which matters more than what
 * bots will.
 *
 * The obvious name is `company`, and it is the wrong one: Chrome and most
 * password managers recognise an organization field and will autofill it, from
 * a stored profile, into an input the person cannot see. That turns the trap on
 * the user and locks them out of signing up with no visible cause. A note field
 * is in no autofill vocabulary, so nothing fills it on anyone's behalf.
 *
 * It costs nothing on the catching side. The traffic a honeypot stops is the
 * kind that fills every input it finds, and it finds this one either way.
 */
export const HONEYPOT_FIELD = 'contact_note';

/**
 * True when the honeypot came back filled.
 *
 * Whitespace counts as empty: a browser that autofills a space into a hidden
 * input would otherwise lock a real person out of signing up.
 */
export function isHoneypotFilled(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const raw = (body as Record<string, unknown>)[HONEYPOT_FIELD];
  if (raw === undefined || raw === null) return false;
  return String(raw).trim().length > 0;
}
