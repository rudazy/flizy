/** Password rules (no email verification). Keep in sync with lib/passwordPolicy.js */

const SPECIAL = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/;

export function validatePassword(password: string): { ok: true } | { ok: false; error: string } {
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

/** One mark per rule in validatePassword. All true means that check accepts. */
export function passwordChecklist(password: string): { label: string; ok: boolean }[] {
  const p = String(password || '');
  return [
    { label: '8 to 128 characters', ok: p.length >= 8 && p.length <= 128 },
    {
      label: 'Include a letter and a number',
      ok: /[a-zA-Z]/.test(p) && /[0-9]/.test(p),
    },
    { label: 'Include a special character (!@#$%)', ok: SPECIAL.test(p) },
  ];
}
