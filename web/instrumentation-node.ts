/**
 * The node-runtime half of the cold start schema check. See instrumentation.ts
 * for why this is a separate module.
 *
 * It deliberately never throws. Throwing here takes down every route, including
 * the ones that do not touch the missing object, which is a worse outcome than
 * the drift it would be reporting. Observability, not enforcement: promoting it
 * to a hard failure means first deciding what a half broken site should do.
 */

import { checkSchema } from './lib/schemaGuard.mjs';
import { getSupabase } from './lib/supabase.ts';
import manifest from './lib/generated/schemaManifest.json';

const result = await checkSchema(getSupabase(), manifest as never).catch((err: unknown) => ({
  ok: false,
  surface: 'web',
  checked: 0,
  missing: [],
  // Never let the check itself break a boot it was only observing.
  message: `cold start check did not run: ${err instanceof Error ? err.message : String(err)}`,
}));

if (result.ok) {
  console.log(`[schema-guard] ${result.checked} objects present (${result.surface}).`);
} else {
  console.error(`[schema-guard] ${result.message}`);
}
