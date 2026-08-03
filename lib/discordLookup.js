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
 * @param {string} raw handle or snowflake
 * @returns {Promise<{ id: string, login: string } | null>}
 */
async function resolveDiscordUser(raw) {
  const s = String(raw || '').trim().replace(/^@+/, '');
  if (!s) {
    const err = new Error('Invalid Discord user.');
    err.code = 'DISCORD_INVALID';
    throw err;
  }

  if (isDiscordSnowflake(s)) {
    return { id: s, login: s };
  }

  const handle = normalizeDiscordHandle(s);
  if (!handle || handle.length > 32) {
    const err = new Error('Invalid Discord username or id.');
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
    const err = new Error(
      'That Discord name matches more than one account. Use their Discord user id instead.'
    );
    err.code = 'DISCORD_AMBIGUOUS';
    throw err;
  }

  // Not on Flizy yet under that handle — tell the sender how to address by id.
  return null;
}

module.exports = {
  isDiscordSnowflake,
  normalizeDiscordHandle,
  resolveDiscordUser,
};
