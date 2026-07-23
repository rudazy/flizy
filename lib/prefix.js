/**
 * Phase 4: every bot action is prefixed with "flizy".
 * Example: flizy send 0.001 to mum
 */

/**
 * @param {string} text
 * @param {{ requirePrefix?: boolean }} opts
 * @returns {{ ok: boolean, body: string, hadPrefix: boolean }}
 */
function stripFlizyPrefix(text, opts = {}) {
  const raw = String(text || '').trim();
  const requirePrefix = opts.requirePrefix !== false;

  const m = raw.match(/^flizy(?:\s+|$)(.*)$/i);
  if (m) {
    return { ok: true, body: (m[1] || '').trim(), hadPrefix: true };
  }

  if (!requirePrefix) {
    return { ok: true, body: raw, hadPrefix: false };
  }

  return { ok: false, body: '', hadPrefix: false };
}

/**
 * flizy unlock           → interactive password prompt
 * flizy unlock SECRET    → one-shot (PIN or account password)
 * @param {string} body command body without prefix
 * @returns {{ pin: string|null } | null}
 */
function parseUnlockCommand(body) {
  const t = String(body || '').trim();
  if (/^unlock\s*$/i.test(t)) return { pin: null };
  const m = t.match(/^unlock\s+(.+)$/i);
  if (!m) return null;
  return { pin: m[1].trim() };
}

function parseLockCommand(body) {
  const t = String(body || '').trim().toLowerCase();
  return t === 'lock';
}

module.exports = {
  stripFlizyPrefix,
  parseUnlockCommand,
  parseLockCommand,
};
