/**
 * Cold start schema check.
 *
 * This is NOT the web gate. The gate is the build step
 * (web/scripts/verify-schema.mjs), which stops a bad deploy before it promotes.
 * Next runs register() once per server instance rather than per request, so on
 * Vercel this fires on a lambda cold start. It exists to catch the one case a
 * build time check cannot see: the database changing under a deployed build.
 *
 * The work lives in instrumentation-node.ts and is reached only through a
 * dynamic import inside this runtime check. Next compiles this file for the
 * edge runtime as well, and it substitutes NEXT_RUNTIME as a literal per
 * compilation, so the edge build eliminates the branch entirely. Written any
 * other way, the edge bundle tries to resolve the node builtins that the
 * Supabase client pulls in, and the build fails.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
