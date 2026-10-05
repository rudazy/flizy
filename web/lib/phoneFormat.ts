/**
 * Phone entry on the site.
 *
 * The country is chosen here, so a trunk 0 in the local field is safe to drop.
 * Chat does not do that unless the person has saved a calling code.
 *
 * composePhoneE164 must stay identical to lib/phone.js. The country list must
 * stay identical to callingCodeOptions() in lib/phoneCountries.js.
 * One row per country. The ISO code is the select value.
 * test/phoneFormat.test.js runs both.
 */

export const SITE_PHONE_COUNTRIES: Array<{ iso: string; name: string; dial: string }> = [
  { iso: 'DZ', name: "Algeria", dial: '213' },
  { iso: 'AO', name: "Angola", dial: '244' },
  { iso: 'AR', name: "Argentina", dial: '54' },
  { iso: 'AU', name: "Australia", dial: '61' },
  { iso: 'AT', name: "Austria", dial: '43' },
  { iso: 'BH', name: "Bahrain", dial: '973' },
  { iso: 'BD', name: "Bangladesh", dial: '880' },
  { iso: 'BE', name: "Belgium", dial: '32' },
  { iso: 'BJ', name: "Benin", dial: '229' },
  { iso: 'BO', name: "Bolivia", dial: '591' },
  { iso: 'BW', name: "Botswana", dial: '267' },
  { iso: 'BR', name: "Brazil", dial: '55' },
  { iso: 'BG', name: "Bulgaria", dial: '359' },
  { iso: 'BF', name: "Burkina Faso", dial: '226' },
  { iso: 'BI', name: "Burundi", dial: '257' },
  { iso: 'KH', name: "Cambodia", dial: '855' },
  { iso: 'CM', name: "Cameroon", dial: '237' },
  { iso: 'CA', name: "Canada", dial: '1' },
  { iso: 'CV', name: "Cape Verde", dial: '238' },
  { iso: 'CF', name: "Central African Republic", dial: '236' },
  { iso: 'TD', name: "Chad", dial: '235' },
  { iso: 'CL', name: "Chile", dial: '56' },
  { iso: 'CN', name: "China", dial: '86' },
  { iso: 'CO', name: "Colombia", dial: '57' },
  { iso: 'CG', name: "Congo", dial: '242' },
  { iso: 'CR', name: "Costa Rica", dial: '506' },
  { iso: 'CI', name: "Cote d'Ivoire", dial: '225' },
  { iso: 'HR', name: "Croatia", dial: '385' },
  { iso: 'CZ', name: "Czechia", dial: '420' },
  { iso: 'DK', name: "Denmark", dial: '45' },
  { iso: 'CD', name: "DR Congo", dial: '243' },
  { iso: 'EC', name: "Ecuador", dial: '593' },
  { iso: 'EG', name: "Egypt", dial: '20' },
  { iso: 'SV', name: "El Salvador", dial: '503' },
  { iso: 'GQ', name: "Equatorial Guinea", dial: '240' },
  { iso: 'ER', name: "Eritrea", dial: '291' },
  { iso: 'SZ', name: "Eswatini", dial: '268' },
  { iso: 'ET', name: "Ethiopia", dial: '251' },
  { iso: 'FI', name: "Finland", dial: '358' },
  { iso: 'FR', name: "France", dial: '33' },
  { iso: 'GA', name: "Gabon", dial: '241' },
  { iso: 'GM', name: "Gambia", dial: '220' },
  { iso: 'DE', name: "Germany", dial: '49' },
  { iso: 'GH', name: "Ghana", dial: '233' },
  { iso: 'GR', name: "Greece", dial: '30' },
  { iso: 'GT', name: "Guatemala", dial: '502' },
  { iso: 'GN', name: "Guinea", dial: '224' },
  { iso: 'GW', name: "Guinea-Bissau", dial: '245' },
  { iso: 'HN', name: "Honduras", dial: '504' },
  { iso: 'HK', name: "Hong Kong", dial: '852' },
  { iso: 'HU', name: "Hungary", dial: '36' },
  { iso: 'IN', name: "India", dial: '91' },
  { iso: 'ID', name: "Indonesia", dial: '62' },
  { iso: 'IR', name: "Iran", dial: '98' },
  { iso: 'IQ', name: "Iraq", dial: '964' },
  { iso: 'IE', name: "Ireland", dial: '353' },
  { iso: 'IL', name: "Israel", dial: '972' },
  { iso: 'IT', name: "Italy", dial: '39' },
  { iso: 'JP', name: "Japan", dial: '81' },
  { iso: 'JO', name: "Jordan", dial: '962' },
  { iso: 'KZ', name: "Kazakhstan", dial: '7' },
  { iso: 'KE', name: "Kenya", dial: '254' },
  { iso: 'KW', name: "Kuwait", dial: '965' },
  { iso: 'LB', name: "Lebanon", dial: '961' },
  { iso: 'LS', name: "Lesotho", dial: '266' },
  { iso: 'LR', name: "Liberia", dial: '231' },
  { iso: 'LY', name: "Libya", dial: '218' },
  { iso: 'MG', name: "Madagascar", dial: '261' },
  { iso: 'MW', name: "Malawi", dial: '265' },
  { iso: 'MY', name: "Malaysia", dial: '60' },
  { iso: 'ML', name: "Mali", dial: '223' },
  { iso: 'MR', name: "Mauritania", dial: '222' },
  { iso: 'MU', name: "Mauritius", dial: '230' },
  { iso: 'MX', name: "Mexico", dial: '52' },
  { iso: 'MA', name: "Morocco", dial: '212' },
  { iso: 'MZ', name: "Mozambique", dial: '258' },
  { iso: 'MM', name: "Myanmar", dial: '95' },
  { iso: 'NA', name: "Namibia", dial: '264' },
  { iso: 'NP', name: "Nepal", dial: '977' },
  { iso: 'NL', name: "Netherlands", dial: '31' },
  { iso: 'NZ', name: "New Zealand", dial: '64' },
  { iso: 'NI', name: "Nicaragua", dial: '505' },
  { iso: 'NE', name: "Niger", dial: '227' },
  { iso: 'NG', name: "Nigeria", dial: '234' },
  { iso: 'NO', name: "Norway", dial: '47' },
  { iso: 'OM', name: "Oman", dial: '968' },
  { iso: 'PK', name: "Pakistan", dial: '92' },
  { iso: 'PA', name: "Panama", dial: '507' },
  { iso: 'PG', name: "Papua New Guinea", dial: '675' },
  { iso: 'PY', name: "Paraguay", dial: '595' },
  { iso: 'PE', name: "Peru", dial: '51' },
  { iso: 'PH', name: "Philippines", dial: '63' },
  { iso: 'PL', name: "Poland", dial: '48' },
  { iso: 'PT', name: "Portugal", dial: '351' },
  { iso: 'QA', name: "Qatar", dial: '974' },
  { iso: 'RO', name: "Romania", dial: '40' },
  { iso: 'RU', name: "Russia", dial: '7' },
  { iso: 'RW', name: "Rwanda", dial: '250' },
  { iso: 'SA', name: "Saudi Arabia", dial: '966' },
  { iso: 'SN', name: "Senegal", dial: '221' },
  { iso: 'RS', name: "Serbia", dial: '381' },
  { iso: 'SC', name: "Seychelles", dial: '248' },
  { iso: 'SL', name: "Sierra Leone", dial: '232' },
  { iso: 'SG', name: "Singapore", dial: '65' },
  { iso: 'SK', name: "Slovakia", dial: '421' },
  { iso: 'SI', name: "Slovenia", dial: '386' },
  { iso: 'SO', name: "Somalia", dial: '252' },
  { iso: 'ZA', name: "South Africa", dial: '27' },
  { iso: 'KR', name: "South Korea", dial: '82' },
  { iso: 'SS', name: "South Sudan", dial: '211' },
  { iso: 'ES', name: "Spain", dial: '34' },
  { iso: 'LK', name: "Sri Lanka", dial: '94' },
  { iso: 'SD', name: "Sudan", dial: '249' },
  { iso: 'SE', name: "Sweden", dial: '46' },
  { iso: 'CH', name: "Switzerland", dial: '41' },
  { iso: 'TW', name: "Taiwan", dial: '886' },
  { iso: 'TZ', name: "Tanzania", dial: '255' },
  { iso: 'TH', name: "Thailand", dial: '66' },
  { iso: 'TG', name: "Togo", dial: '228' },
  { iso: 'TN', name: "Tunisia", dial: '216' },
  { iso: 'TR', name: "Turkey", dial: '90' },
  { iso: 'UG', name: "Uganda", dial: '256' },
  { iso: 'UA', name: "Ukraine", dial: '380' },
  { iso: 'AE', name: "United Arab Emirates", dial: '971' },
  { iso: 'GB', name: "United Kingdom", dial: '44' },
  { iso: 'US', name: "United States", dial: '1' },
  { iso: 'UY', name: "Uruguay", dial: '598' },
  { iso: 'VE', name: "Venezuela", dial: '58' },
  { iso: 'VN', name: "Vietnam", dial: '84' },
  { iso: 'YE', name: "Yemen", dial: '967' },
  { iso: 'ZM', name: "Zambia", dial: '260' },
  { iso: 'ZW', name: "Zimbabwe", dial: '263' },
];

/**
 * Flag for a two-letter country code. Empty when the code is not two letters.
 */
export function countryFlag(iso: string): string {
  const code = String(iso || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return [...code].map((ch) => String.fromCodePoint(0x1f1e6 + ch.charCodeAt(0) - 65)).join('');
}

/** The one country for an ISO code, or null. */
export function countryByIso(iso: string) {
  const code = String(iso || '').trim().toUpperCase();
  return SITE_PHONE_COUNTRIES.find((country) => country.iso === code) || null;
}

/**
 * A calling code safe to store. Empty when the value is not 1 to 4 digits,
 * or when it starts with 0. A blank value means "no default".
 */
export function normalizeStoredCallingCode(raw: string): string {
  const code = String(raw || '').replace(/\D/g, '');
  if (!/^[1-9]\d{0,3}$/.test(code)) return '';
  return code;
}

/**
 * Spaces for the chat example. Groups of three, except a leftover single
 * digit stays with the group before it, so 7080437343 reads 708 043 7343.
 */
export function groupPhoneLocal(value: string): string {
  const digits = String(value || '')
    .replace(/\D/g, '')
    .replace(/^0+/, '');
  if (digits.length <= 3) return digits;
  const groups: string[] = [];
  let index = 0;
  const keepLastFour = digits.length % 3 === 1;
  const stop = keepLastFour ? digits.length - 4 : digits.length;
  while (index < stop) {
    groups.push(digits.slice(index, index + 3));
    index += 3;
  }
  if (index < digits.length) groups.push(digits.slice(index));
  return groups.join(' ');
}

export function composePhoneE164(callingCode: string, local: string): string {
  const code = String(callingCode || '').replace(/\D/g, '');
  const rest = String(local || '')
    .replace(/\D/g, '')
    .replace(/^0+/, '');
  if (!code || !rest || code.length > 4) return '';
  const e164 = code + rest;
  if (e164.length < 10 || e164.length > 15) return '';
  if (e164.startsWith('0')) return '';
  return e164;
}
