/**
 * Serialise a JSON-LD graph for embedding inside a <script> block.
 *
 * `JSON.stringify` does not escape `<`, so a string value containing
 * `</script>` closes the block early and everything after it is parsed as
 * markup rather than data. Nothing fed to these graphs does that today, but
 * components/JsonLd.tsx builds `sameAs` from NEXT_PUBLIC_ORG_SAME_AS and only
 * checks that each entry starts with http, so the rest of the value is not
 * constrained by the code at all.
 *
 * Escaping the angle bracket removes the question entirely. `<` is a valid
 * JSON escape and every parser reads it back as `<`, so the structured data is
 * unchanged for anything consuming it.
 *
 * Lives here rather than beside the components so it can be tested directly:
 * the test runner strips TypeScript types but does not compile JSX, and a
 * module that exports a component cannot be imported from a test.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
