/**
 * Country names and calling codes a person can type.
 *
 * The numbered chat question stays at three countries. This list is how a
 * name ("france", "korea") or a code ("+82") becomes digits. It is not a
 * default. Two countries may share a code (United States and Canada are
 * both 1). A saved choice is one country. The dial is what a send prefixes.
 *
 * A code that is not in this list can still be saved or typed as +digits.
 * Naming a country only works when the name is here.
 */

/** @typedef {{ name: string, iso: string, dial: string, aliases?: string[] }} PhoneCountry */

/** @type {readonly PhoneCountry[]} */
const PHONE_COUNTRIES = Object.freeze([
  { name: 'Nigeria', iso: 'NG', dial: '234', aliases: ['ng'] },
  { name: 'Ghana', iso: 'GH', dial: '233', aliases: ['gh'] },
  {
    name: 'United Kingdom', iso: 'GB',
    dial: '44',
    aliases: ['uk', 'britain', 'great britain', 'gb', 'england', 'scotland', 'wales', 'northern ireland'],
  },
  { name: 'United States', iso: 'US', dial: '1', aliases: ['us', 'usa', 'america'] },
  { name: 'Canada', iso: 'CA', dial: '1', aliases: ['ca'] },
  { name: 'Kenya', iso: 'KE', dial: '254', aliases: ['ke'] },
  { name: 'South Africa', iso: 'ZA', dial: '27', aliases: ['rsa'] },
  { name: 'Egypt', iso: 'EG', dial: '20' },
  { name: 'Morocco', iso: 'MA', dial: '212' },
  { name: 'Algeria', iso: 'DZ', dial: '213' },
  { name: 'Tunisia', iso: 'TN', dial: '216' },
  { name: 'Libya', iso: 'LY', dial: '218' },
  { name: 'Ethiopia', iso: 'ET', dial: '251' },
  { name: 'Tanzania', iso: 'TZ', dial: '255' },
  { name: 'Uganda', iso: 'UG', dial: '256' },
  { name: 'Rwanda', iso: 'RW', dial: '250' },
  { name: 'Burundi', iso: 'BI', dial: '257' },
  { name: 'Somalia', iso: 'SO', dial: '252' },
  { name: 'Eritrea', iso: 'ER', dial: '291' },
  { name: 'South Sudan', iso: 'SS', dial: '211' },
  { name: 'Sudan', iso: 'SD', dial: '249' },
  { name: 'Senegal', iso: 'SN', dial: '221' },
  { name: "Cote d'Ivoire", iso: 'CI', dial: '225', aliases: ['ivory coast'] },
  { name: 'Cameroon', iso: 'CM', dial: '237' },
  { name: 'Benin', iso: 'BJ', dial: '229' },
  { name: 'Togo', iso: 'TG', dial: '228' },
  { name: 'Burkina Faso', iso: 'BF', dial: '226' },
  { name: 'Mali', iso: 'ML', dial: '223' },
  { name: 'Niger', iso: 'NE', dial: '227' },
  { name: 'Sierra Leone', iso: 'SL', dial: '232' },
  { name: 'Liberia', iso: 'LR', dial: '231' },
  { name: 'Gambia', iso: 'GM', dial: '220' },
  { name: 'Guinea', iso: 'GN', dial: '224' },
  { name: 'Guinea-Bissau', iso: 'GW', dial: '245' },
  { name: 'Equatorial Guinea', iso: 'GQ', dial: '240' },
  { name: 'Cape Verde', iso: 'CV', dial: '238' },
  { name: 'Mauritania', iso: 'MR', dial: '222' },
  { name: 'Chad', iso: 'TD', dial: '235' },
  { name: 'Central African Republic', iso: 'CF', dial: '236' },
  { name: 'Gabon', iso: 'GA', dial: '241' },
  { name: 'Congo', iso: 'CG', dial: '242', aliases: ['republic of the congo', 'congo brazzaville'] },
  { name: 'DR Congo', iso: 'CD', dial: '243', aliases: ['drc', 'dr congo', 'democratic republic of the congo'] },
  { name: 'Angola', iso: 'AO', dial: '244' },
  { name: 'Mozambique', iso: 'MZ', dial: '258' },
  { name: 'Zambia', iso: 'ZM', dial: '260' },
  { name: 'Zimbabwe', iso: 'ZW', dial: '263' },
  { name: 'Botswana', iso: 'BW', dial: '267' },
  { name: 'Namibia', iso: 'NA', dial: '264' },
  { name: 'Malawi', iso: 'MW', dial: '265' },
  { name: 'Lesotho', iso: 'LS', dial: '266' },
  { name: 'Eswatini', iso: 'SZ', dial: '268' },
  { name: 'Madagascar', iso: 'MG', dial: '261' },
  { name: 'Mauritius', iso: 'MU', dial: '230' },
  { name: 'Seychelles', iso: 'SC', dial: '248' },
  { name: 'Ireland', iso: 'IE', dial: '353', aliases: ['republic of ireland'] },
  { name: 'France', iso: 'FR', dial: '33' },
  { name: 'Germany', iso: 'DE', dial: '49' },
  { name: 'Spain', iso: 'ES', dial: '34' },
  { name: 'Italy', iso: 'IT', dial: '39' },
  { name: 'Portugal', iso: 'PT', dial: '351' },
  { name: 'Netherlands', iso: 'NL', dial: '31', aliases: ['holland'] },
  { name: 'Belgium', iso: 'BE', dial: '32' },
  { name: 'Switzerland', iso: 'CH', dial: '41' },
  { name: 'Austria', iso: 'AT', dial: '43' },
  { name: 'Sweden', iso: 'SE', dial: '46' },
  { name: 'Norway', iso: 'NO', dial: '47' },
  { name: 'Denmark', iso: 'DK', dial: '45' },
  { name: 'Finland', iso: 'FI', dial: '358' },
  { name: 'Poland', iso: 'PL', dial: '48' },
  { name: 'Czechia', iso: 'CZ', dial: '420', aliases: ['czech republic'] },
  { name: 'Slovakia', iso: 'SK', dial: '421' },
  { name: 'Hungary', iso: 'HU', dial: '36' },
  { name: 'Romania', iso: 'RO', dial: '40' },
  { name: 'Bulgaria', iso: 'BG', dial: '359' },
  { name: 'Greece', iso: 'GR', dial: '30' },
  { name: 'Croatia', iso: 'HR', dial: '385' },
  { name: 'Serbia', iso: 'RS', dial: '381' },
  { name: 'Slovenia', iso: 'SI', dial: '386' },
  { name: 'Ukraine', iso: 'UA', dial: '380' },
  { name: 'Turkey', iso: 'TR', dial: '90' },
  { name: 'Russia', iso: 'RU', dial: '7', aliases: ['ru'] },
  { name: 'Kazakhstan', iso: 'KZ', dial: '7', aliases: ['kz'] },
  { name: 'India', iso: 'IN', dial: '91' },
  { name: 'Pakistan', iso: 'PK', dial: '92' },
  { name: 'Bangladesh', iso: 'BD', dial: '880' },
  { name: 'Sri Lanka', iso: 'LK', dial: '94' },
  { name: 'Nepal', iso: 'NP', dial: '977' },
  { name: 'China', iso: 'CN', dial: '86' },
  { name: 'Hong Kong', iso: 'HK', dial: '852' },
  { name: 'Taiwan', iso: 'TW', dial: '886' },
  { name: 'Japan', iso: 'JP', dial: '81' },
  { name: 'South Korea', iso: 'KR', dial: '82', aliases: ['korea', 'kr'] },
  { name: 'Indonesia', iso: 'ID', dial: '62' },
  { name: 'Malaysia', iso: 'MY', dial: '60' },
  { name: 'Singapore', iso: 'SG', dial: '65' },
  { name: 'Philippines', iso: 'PH', dial: '63' },
  { name: 'Thailand', iso: 'TH', dial: '66' },
  { name: 'Vietnam', iso: 'VN', dial: '84' },
  { name: 'Cambodia', iso: 'KH', dial: '855' },
  { name: 'Myanmar', iso: 'MM', dial: '95', aliases: ['burma'] },
  { name: 'United Arab Emirates', iso: 'AE', dial: '971', aliases: ['uae', 'emirates'] },
  { name: 'Saudi Arabia', iso: 'SA', dial: '966', aliases: ['ksa'] },
  { name: 'Qatar', iso: 'QA', dial: '974' },
  { name: 'Kuwait', iso: 'KW', dial: '965' },
  { name: 'Bahrain', iso: 'BH', dial: '973' },
  { name: 'Oman', iso: 'OM', dial: '968' },
  { name: 'Israel', iso: 'IL', dial: '972' },
  { name: 'Jordan', iso: 'JO', dial: '962' },
  { name: 'Lebanon', iso: 'LB', dial: '961' },
  { name: 'Iraq', iso: 'IQ', dial: '964' },
  { name: 'Iran', iso: 'IR', dial: '98' },
  { name: 'Yemen', iso: 'YE', dial: '967' },
  { name: 'Australia', iso: 'AU', dial: '61' },
  { name: 'New Zealand', iso: 'NZ', dial: '64' },
  { name: 'Papua New Guinea', iso: 'PG', dial: '675' },
  { name: 'Mexico', iso: 'MX', dial: '52' },
  { name: 'Brazil', iso: 'BR', dial: '55' },
  { name: 'Argentina', iso: 'AR', dial: '54' },
  { name: 'Colombia', iso: 'CO', dial: '57' },
  { name: 'Chile', iso: 'CL', dial: '56' },
  { name: 'Peru', iso: 'PE', dial: '51' },
  { name: 'Venezuela', iso: 'VE', dial: '58' },
  { name: 'Ecuador', iso: 'EC', dial: '593' },
  { name: 'Bolivia', iso: 'BO', dial: '591' },
  { name: 'Paraguay', iso: 'PY', dial: '595' },
  { name: 'Uruguay', iso: 'UY', dial: '598' },
  { name: 'Costa Rica', iso: 'CR', dial: '506' },
  { name: 'Panama', iso: 'PA', dial: '507' },
  { name: 'Guatemala', iso: 'GT', dial: '502' },
  { name: 'Nicaragua', iso: 'NI', dial: '505' },
  { name: 'Honduras', iso: 'HN', dial: '504' },
  { name: 'El Salvador', iso: 'SV', dial: '503' },
]);

/**
 * Compare names the way a person types them.
 * @param {string} value
 */
function foldCountryName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @type {Map<string, PhoneCountry | null>} */
const BY_NAME = new Map();
for (const country of PHONE_COUNTRIES) {
  for (const key of [country.name, ...(country.aliases || [])]) {
    const folded = foldCountryName(key);
    if (!folded) continue;
    const prev = BY_NAME.get(folded);
    if (prev && prev.dial !== country.dial) BY_NAME.set(folded, null);
    else if (prev === undefined) BY_NAME.set(folded, country);
  }
}

/**
 * Digits of a calling code, or empty. A leading 0 is a trunk prefix, not a code.
 * @param {string} raw
 * @returns {string}
 */
function normalizeCallingCode(raw) {
  const compact = String(raw || '')
    .trim()
    .replace(/[\s()-]/g, '');
  if (!/^\+?\d{1,4}$/.test(compact)) return '';
  const code = compact.replace(/\D/g, '');
  if (!/^[1-9]\d{0,3}$/.test(code)) return '';
  return code;
}

/**
 * A country name or a calling code, as digits. Empty when the name is unknown
 * or matches two different codes. Does not treat 1, 2 or 3 as a menu.
 * @param {string} raw
 * @returns {string}
 */
function lookupCallingCode(raw) {
  const country = lookupCountry(raw);
  return country ? country.dial : '';
}

/**
 * The one country a name or a code refers to.
 * A shared code such as +1 has no single country, so iso is null and the dial
 * is still returned. An unknown name is null.
 * @param {string} raw
 * @returns {{ iso: string | null, dial: string, name: string | null } | null}
 */
function lookupCountry(raw) {
  const folded = foldCountryName(raw);
  if (folded && BY_NAME.has(folded)) {
    const country = BY_NAME.get(folded);
    if (!country) return null;
    return { iso: country.iso, dial: country.dial, name: country.name };
  }
  const dial = normalizeCallingCode(raw);
  if (!dial) return null;
  const matches = PHONE_COUNTRIES.filter((country) => country.dial === dial);
  if (matches.length === 1) {
    return { iso: matches[0].iso, dial, name: matches[0].name };
  }
  return { iso: null, dial, name: null };
}

/**
 * @param {string} iso
 * @returns {PhoneCountry | null}
 */
function countryByIso(iso) {
  const code = String(iso || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return PHONE_COUNTRIES.find((country) => country.iso === code) || null;
}

/**
 * Regional-indicator flag for an ISO country. Empty when the code is not two letters.
 * @param {string} iso
 * @returns {string}
 */
function countryFlag(iso) {
  const code = String(iso || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return [...code].map((ch) => String.fromCodePoint(0x1f1e6 + ch.charCodeAt(0) - 65)).join('');
}

/** Longest dial first, so 234 wins over 23 and 1. */
const DIALS_LONGEST = Object.freeze(
  [...new Set(PHONE_COUNTRIES.map((country) => country.dial))].sort((a, b) => b.length - a.length)
);

/**
 * Calling code already present in a digit string, or empty.
 * The digits after the code must not start with 0: that is a trunk prefix,
 * so 1012345678 is not United States +1.
 *
 * minNational is the shortest subscriber length that counts. The default, 6,
 * finds any real code. A caller that treats an unmarked number as already
 * international passes 10, so a 10-digit local number cannot borrow a shorter
 * country code. 2025550100 is not Egypt +20. A longer code is tried first.
 * +1 counts only when the tail is exactly 10 digits and both the area code
 * and the exchange start with 2 to 9. 13800138000 is not +1. 12425550100
 * still is. A longer tail is not +1 either: 138123456789 is 12 digits.
 * @param {string} digits
 * @param {number} [minNational]
 * @returns {string}
 */
function internationalCallingPrefix(digits, minNational = 6) {
  const value = String(digits || '');
  if (!/^[1-9]\d{9,14}$/.test(value)) return '';
  const floor = Number.isInteger(minNational) && minNational > 6 ? minNational : 6;
  for (const dial of DIALS_LONGEST) {
    if (!value.startsWith(dial)) continue;
    const national = value.slice(dial.length);
    if (national.length < floor || national.length > 12 || national.startsWith('0')) continue;
    // +1 is exactly 10 subscriber digits. An 11 or 12 digit tail is a
    // different country's local number that happens to start with 1.
    if (dial === '1' && (national.length !== 10 || !/^[2-9]\d{2}[2-9]\d{6}$/.test(national))) {
      continue;
    }
    return dial;
  }
  return '';
}

/**
 * "Nigeria +234", or "+960" when the code was saved but is not named here.
 * Shared codes list every country that uses them.
 * @param {string} code
 * @returns {string}
 */
function describeCallingCode(code) {
  const dial = normalizeCallingCode(code);
  if (!dial) return '';
  const names = PHONE_COUNTRIES.filter((country) => country.dial === dial).map((country) => country.name);
  if (!names.length) return `+${dial}`;
  return `${names.join(', ')} +${dial}`;
}

/**
 * One option per country, for a select. The value is the ISO code, so
 * United States and Canada stay two choices even though both dial 1.
 * @returns {Array<{ iso: string, dial: string, name: string, flag: string }>}
 */
function callingCodeOptions() {
  return PHONE_COUNTRIES.map((country) => ({
    iso: country.iso,
    dial: country.dial,
    name: country.name,
    flag: countryFlag(country.iso),
  })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

module.exports = {
  PHONE_COUNTRIES,
  foldCountryName,
  normalizeCallingCode,
  lookupCallingCode,
  lookupCountry,
  countryByIso,
  countryFlag,
  internationalCallingPrefix,
  describeCallingCode,
  callingCodeOptions,
};
