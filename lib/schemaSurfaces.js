/**
 * The two runtimes that talk to the database, and where each one's derived
 * object list is cached.
 *
 * Each surface scans only its own source. The bot must not refuse to start
 * because the site uses a table the bot never touches, and the reverse.
 *
 * Paths only. Kept apart from the parser so the generator, the drift test and
 * the web build step all agree on what a surface is.
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

const SURFACES = [
  {
    name: 'bot',
    manifest: path.join(ROOT, 'lib', 'generated', 'schemaManifest.json'),
    codeRoots: [
      path.join(ROOT, 'lib'),
      path.join(ROOT, 'index.js'),
      path.join(ROOT, 'telegram.js'),
    ],
  },
  {
    name: 'web',
    manifest: path.join(ROOT, 'web', 'lib', 'generated', 'schemaManifest.json'),
    codeRoots: [
      path.join(ROOT, 'web', 'lib'),
      path.join(ROOT, 'web', 'app'),
      path.join(ROOT, 'web', 'components'),
      // Runtime entrypoints that sit at the web root rather than in a scanned
      // directory. Listed explicitly so a query added here is not invisible.
      path.join(ROOT, 'web', 'instrumentation.ts'),
      path.join(ROOT, 'web', 'instrumentation-node.ts'),
    ],
  },
];

/** @param {string} name */
function surface(name) {
  const found = SURFACES.find((s) => s.name === name);
  if (!found) throw new Error(`unknown schema surface "${name}"`);
  return found;
}

module.exports = { ROOT, MIGRATIONS_DIR, SURFACES, surface };
