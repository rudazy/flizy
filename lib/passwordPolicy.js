/**
 * Password rules for site signup (no email verification).
 * Min 8 chars, at least one letter, one number, one special character.
 */

const SPECIAL = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/;

/**
 * @param {string} password
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validatePassword(password) {
  const p = String(password || '');
  if (p.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters' };
  }
  if (p.length > 128) {
    return { ok: false, error: 'Password is too long' };
  }
  if (!/[a-zA-Z]/.test(p)) {
    return { ok: false, error: 'Password must include a letter' };
  }
  if (!/[0-9]/.test(p)) {
    return { ok: false, error: 'Password must include a number' };
  }
  if (!SPECIAL.test(p)) {
    return {
      ok: false,
      error: 'Password must include a special character (e.g. !@#$%)',
    };
  }
  return { ok: true };
}

module.exports = { validatePassword, SPECIAL };
