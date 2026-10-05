/**
 * The legal person behind flizy.app.
 *
 * Kept in one place because it appears in the footer on every page, the
 * opening of the Terms, the opening of the Privacy policy, and the
 * Organization JSON-LD.
 *
 * The public site says the company is incorporated. It does not name a
 * country, and it does not publish a registration number.
 */

export const ENTITY = {
  /** Registered company name, as filed. */
  legalName: 'Flizy Tek Ltd',
} as const;

/**
 * Footer and legal documents share one sentence. The name stays so the
 * agreement and the privacy policy still name a counterparty. Nothing else
 * about the filing is published.
 */
export const ENTITY_LINE = `${ENTITY.legalName}, an incorporated company`;

export const ENTITY_SENTENCE = ENTITY_LINE;
