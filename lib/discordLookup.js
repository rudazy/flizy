/**
 * Resolve a Discord target to the immutable snowflake user id.
 *
 * Discord has no free public "username → id" API. Preferred send form for
 * unknown users is the numeric user id (Developer Mode → Copy User ID).
 * Handles are accepted when they already appear on a Flizy-linked identity
 * (display_handle), so you can still pay people already on Flizy by name.
 */

const { getSupabase } = require('./supabase');

/** Discord snowflakes are large numeric strings. */
function isDiscordSnowflake(raw) {
  return /^\d{15,22}$/.test(String(raw || '').trim());
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeDiscordHandle(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/#\d{0,4}$/, ''); // legacy discriminator
}

/**
 * Short, human copy: how to get a Discord user id.
 * @param {(body: string) => string} [cmd] optional flizy/slash formatter
 * @returns {string[]}
 */
function discordIdHowToLines(cmd) {
  const example = cmd
    ? cmd('send 0.001 to 123456789012345678 on discord')
    : 'flizy send 0.001 to 123456789012345678 on discord';
  return [
    'How to get their Discord user id:',
    '  1) Discord Settings → Advanced → turn on Developer Mode',
    '  2) Right-click their name (or profile) → Copy User ID',
    '  3) Paste that long number into send:',
    `     ${example}`,
    '',
    'Handles only work after they link Discord on Flizy.',
    'Discord does not let us look up strangers by name.',
  ];
}

/**
 * @param {(body: string) => string} [cmd]
 * @returns {string}
 */
function discordNotFoundMessage(cmd) {
  return [
    'Could not find that Discord name on Flizy.',
    '',
    ...discordIdHowToLines(cmd),
  ].join('\n');
}

/**
 * @param {(body: string) => string} [cmd]
 * @returns {string}
 */
function discordAmbiguousMessage(cmd) {
  return [
    'That Discord name matches more than one Flizy account.',
    'Use their Discord user id so the right person is paid.',
    '',
    ...discordIdHowToLines(cmd),
  ].join('\n');
}

/**
 * @param {(body: string) => string} [cmd]
 * @returns {string}
 */
function discordInvalidMessage(cmd) {
  return [
    'That does not look like a Discord user id or username.',
    'Use the long number from Copy User ID, or a name already linked on Flizy.',
    '',
    ...discordIdHowToLines(cmd),
  ].join('\n');
}

/**
 * @param {string} raw handle or snowflake
 * @returns {Promise<{ id: string, login: string } | null>}
 */
async function resolveDiscordUser(raw) {
  const s = String(raw || '').trim().replace(/^@+/, '');
  if (!s) {
    const err = new Error(discordInvalidMessage());
    err.code = 'DISCORD_INVALID';
    throw err;
  }

  if (isDiscordSnowflake(s)) {
    // Do not set login to the snowflake — that would render as "@123…" in receipts.
    // Display handle stays empty; label becomes "Discord user 123…".
    return { id: s, login: '' };
  }

  const handle = normalizeDiscordHandle(s);
  if (!handle || handle.length > 32) {
    const err = new Error(discordInvalidMessage());
    err.code = 'DISCORD_INVALID';
    throw err;
  }

  // Only resolve names we already know from a completed OAuth bind.
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('channel_identities')
    .select('external_id, display_handle')
    .eq('channel', 'discord')
    .ilike('display_handle', handle)
    .limit(5);

  if (error) {
    const err = new Error('Could not look up that Discord user. Try again shortly.');
    err.code = 'DISCORD_LOOKUP_FAILED';
    throw err;
  }

  const rows = data || [];
  if (rows.length === 1 && rows[0].external_id && /^\d+$/.test(String(rows[0].external_id))) {
    return {
      id: String(rows[0].external_id),
      login: String(rows[0].display_handle || handle),
    };
  }
  if (rows.length > 1) {
    const err = new Error(discordAmbiguousMessage());
    err.code = 'DISCORD_AMBIGUOUS';
    throw err;
  }

  // Not on Flizy yet under that handle — caller shows discordNotFoundMessage.
  return null;
}

module.exports = {
  isDiscordSnowflake,
  normalizeDiscordHandle,
  discordIdHowToLines,
  discordNotFoundMessage,
  discordAmbiguousMessage,
  discordInvalidMessage,
  resolveDiscordUser,
};
