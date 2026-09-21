/**
 * The legal person behind flizy.app.
 *
 * Kept in one place because it now appears in four: the footer on every page,
 * the opening of the Terms, the opening of the Privacy policy, and the
 * Organization JSON-LD. A registration number retyped in four files is a
 * registration number that will eventually be wrong in one of them, and being
 * wrong about who the data controller is undoes the reason for naming it.
 *
 * Deliberately plain text and not an image or a document. A scan of the
 * incorporation certificate would put a full legal name, and in the case of the
 * status report a residential address and date of birth, on a public site.
 * Anyone who wants to verify can search the RC number at CAC, which proves the
 * same thing and discloses nothing extra.
 */

export const ENTITY = {
  /** Registered company name, as filed. */
  legalName: 'Flizy Tek Ltd',
  /** Registration number as people read it, prefix included. */
  rc: 'RC 9864520',
  /**
   * The same number without the prefix, for anywhere it is published as data
   * rather than prose. The JSON-LD states the scheme in `propertyID`, so
   * repeating "RC" in the value would be saying it twice.
   */
  rcNumber: '9864520',
  /** Country of incorporation. */
  jurisdiction: 'Nigeria',
} as const;

/** One line for the footer: `Flizy Tek Ltd · RC 9864520 · Nigeria`. */
export const ENTITY_LINE = `${ENTITY.legalName} · ${ENTITY.rc} · ${ENTITY.jurisdiction}`;

/**
 * How the entity is introduced inside a legal document, where `we` has to
 * resolve to a named person for the document to bind anyone.
 */
export const ENTITY_SENTENCE = `${ENTITY.legalName} (${ENTITY.rc}), a company incorporated in ${ENTITY.jurisdiction}`;
