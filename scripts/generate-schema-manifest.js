/**
 * Regenerate the cached schema manifests.
 *
 * Deriving from source costs about 170 ms, which is too much to pay on every
 * process start, so the derivation is cached into a generated file per surface
 * and the startup guard just reads it. The cache cannot rot unnoticed:
 * test/schemaManifest.test.js re-derives and fails if a committed manifest no
 * longer matches the code it claims to describe.
 *
 * Usage (Windows CMD):
 *   node scripts\generate-schema-manifest.js
 *   node scripts\generate-schema-manifest.js --check
 *
 * --check writes nothing and exits 1 on drift. Exit 0 = manifests are current.
 */

const fs = require('fs');
const path = require('path');

const { deriveRequirements } = require('../lib/schemaRequirements');
const { ROOT, MIGRATIONS_DIR, SURFACES } = require('../lib/schemaSurfaces');

const REGENERATE = 'node scripts/generate-schema-manifest.js';

/** Derive one surface's manifest. Pure: no filesystem writes. */
function buildManifest(surface) {
  const derived = deriveRequirements({
    surface: surface.name,
    codeRoots: surface.codeRoots,
    migrationsDir: MIGRATIONS_DIR,
    relativeTo: ROOT,
  });

  return {
    _generated: `Derived from source by ${REGENERATE}. Do not edit by hand.`,
    surface: derived.surface,
    objects: derived.objects,
  };
}

function serialize(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function readManifest(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function main() {
  const check = process.argv.includes('--check');
  let drifted = 0;

  for (const surface of SURFACES) {
    const manifest = buildManifest(surface);
    const next = serialize(manifest);
    const current = readManifest(surface.manifest);
    const rel = path.relative(ROOT, surface.manifest).replace(/\\/g, '/');

    if (current === next) {
      console.log(`  ${surface.name.padEnd(4)} up to date  (${manifest.objects.length} objects)  ${rel}`);
      continue;
    }

    if (check) {
      drifted += 1;
      console.error(
        `  ${surface.name.padEnd(4)} DRIFTED     ${rel}\n` +
          `       the committed manifest no longer matches the code it describes.`
      );
      continue;
    }

    fs.mkdirSync(path.dirname(surface.manifest), { recursive: true });
    fs.writeFileSync(surface.manifest, next);
    console.log(
      `  ${surface.name.padEnd(4)} ${current === null ? 'created' : 'updated'}     ` +
        `(${manifest.objects.length} objects)  ${rel}`
    );
  }

  if (drifted) {
    console.error(`\nRun ${REGENERATE} and commit the result.\n`);
    process.exit(1);
  }
}

// Compare resolved paths rather than require.main: the latter is unreliable on
// Windows in some launch contexts, and this script is run directly from CMD.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main();
}

module.exports = { buildManifest, serialize, REGENERATE };
