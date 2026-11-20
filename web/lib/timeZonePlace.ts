/**
 * A place from the browser's time zone, for the sign-in list.
 *
 * IP geolocation can put a network in the wrong country: a phone in Lagos has
 * been listed as Nairobi. The device's own time zone does not depend on the
 * network. It is set by the phone or computer.
 *
 * It is also set by whoever holds the device, so it is display text and never
 * a security signal on its own. sessionClient keeps the network's place next
 * to it whenever the two disagree.
 *
 * The map holds a selection of IANA zones, plus two older names some systems
 * still report (Europe/Kiev, Asia/Calcutta), each with the country the tz
 * database assigns it. test/timeZonePlace.test.js checks every name is a zone
 * the runtime accepts. A zone missing here is not an error: the caller falls
 * back to the network's place.
 */

export const ZONE_COUNTRY: Readonly<Record<string, string>> = {
  // Africa
  'Africa/Abidjan': 'CI',
  'Africa/Accra': 'GH',
  'Africa/Addis_Ababa': 'ET',
  'Africa/Algiers': 'DZ',
  'Africa/Asmara': 'ER',
  'Africa/Bamako': 'ML',
  'Africa/Bangui': 'CF',
  'Africa/Banjul': 'GM',
  'Africa/Bissau': 'GW',
  'Africa/Blantyre': 'MW',
  'Africa/Brazzaville': 'CG',
  'Africa/Bujumbura': 'BI',
  'Africa/Cairo': 'EG',
  'Africa/Casablanca': 'MA',
  'Africa/Conakry': 'GN',
  'Africa/Dakar': 'SN',
  'Africa/Dar_es_Salaam': 'TZ',
  'Africa/Djibouti': 'DJ',
  'Africa/Douala': 'CM',
  'Africa/Freetown': 'SL',
  'Africa/Gaborone': 'BW',
  'Africa/Harare': 'ZW',
  'Africa/Johannesburg': 'ZA',
  'Africa/Juba': 'SS',
  'Africa/Kampala': 'UG',
  'Africa/Khartoum': 'SD',
  'Africa/Kigali': 'RW',
  'Africa/Kinshasa': 'CD',
  'Africa/Lagos': 'NG',
  'Africa/Libreville': 'GA',
  'Africa/Lome': 'TG',
  'Africa/Luanda': 'AO',
  'Africa/Lubumbashi': 'CD',
  'Africa/Lusaka': 'ZM',
  'Africa/Malabo': 'GQ',
  'Africa/Maputo': 'MZ',
  'Africa/Maseru': 'LS',
  'Africa/Mbabane': 'SZ',
  'Africa/Mogadishu': 'SO',
  'Africa/Monrovia': 'LR',
  'Africa/Nairobi': 'KE',
  'Africa/Ndjamena': 'TD',
  'Africa/Niamey': 'NE',
  'Africa/Nouakchott': 'MR',
  'Africa/Ouagadougou': 'BF',
  'Africa/Porto-Novo': 'BJ',
  'Africa/Sao_Tome': 'ST',
  'Africa/Tripoli': 'LY',
  'Africa/Tunis': 'TN',
  'Africa/Windhoek': 'NA',
  'Atlantic/Cape_Verde': 'CV',
  'Indian/Antananarivo': 'MG',
  'Indian/Comoro': 'KM',
  'Indian/Mahe': 'SC',
  'Indian/Mauritius': 'MU',
  // Europe
  'Europe/Amsterdam': 'NL',
  'Europe/Athens': 'GR',
  'Europe/Berlin': 'DE',
  'Europe/Brussels': 'BE',
  'Europe/Bucharest': 'RO',
  'Europe/Budapest': 'HU',
  'Europe/Copenhagen': 'DK',
  'Europe/Dublin': 'IE',
  'Europe/Helsinki': 'FI',
  'Europe/Istanbul': 'TR',
  'Europe/Kiev': 'UA',
  'Europe/Kyiv': 'UA',
  'Europe/Lisbon': 'PT',
  'Europe/London': 'GB',
  'Europe/Madrid': 'ES',
  'Europe/Moscow': 'RU',
  'Europe/Oslo': 'NO',
  'Europe/Paris': 'FR',
  'Europe/Prague': 'CZ',
  'Europe/Rome': 'IT',
  'Europe/Stockholm': 'SE',
  'Europe/Vienna': 'AT',
  'Europe/Warsaw': 'PL',
  'Europe/Zurich': 'CH',
  // Asia
  'Asia/Bangkok': 'TH',
  'Asia/Calcutta': 'IN',
  'Asia/Dhaka': 'BD',
  'Asia/Dubai': 'AE',
  'Asia/Hong_Kong': 'HK',
  'Asia/Jakarta': 'ID',
  'Asia/Jerusalem': 'IL',
  'Asia/Karachi': 'PK',
  'Asia/Kolkata': 'IN',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Manila': 'PH',
  'Asia/Qatar': 'QA',
  'Asia/Riyadh': 'SA',
  'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN',
  'Asia/Singapore': 'SG',
  'Asia/Tokyo': 'JP',
  // Americas
  'America/Anchorage': 'US',
  'America/Argentina/Buenos_Aires': 'AR',
  'America/Bogota': 'CO',
  'America/Caracas': 'VE',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Edmonton': 'CA',
  'America/Halifax': 'CA',
  'America/Jamaica': 'JM',
  'America/Lima': 'PE',
  'America/Los_Angeles': 'US',
  'America/Mexico_City': 'MX',
  'America/New_York': 'US',
  'America/Phoenix': 'US',
  'America/Port_of_Spain': 'TT',
  'America/Santiago': 'CL',
  'America/Sao_Paulo': 'BR',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Winnipeg': 'CA',
  'Pacific/Honolulu': 'US',
  // Oceania
  'Australia/Adelaide': 'AU',
  'Australia/Brisbane': 'AU',
  'Australia/Melbourne': 'AU',
  'Australia/Perth': 'AU',
  'Australia/Sydney': 'AU',
  'Pacific/Auckland': 'NZ',
};

/** Region/City or Region/Area/City, the IANA shape. Nothing else is read. */
const ZONE_SHAPE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;

export type ZonePlace = { city: string; country: string };

/**
 * City and country for a time zone the map knows, or null.
 * The city is the zone's own name (Africa/Lagos is Lagos), so it names the
 * zone, not the exact town the device is in.
 */
export function placeFromTimeZone(raw: unknown): ZonePlace | null {
  const zone = String(raw || '').trim().slice(0, 64);
  if (!ZONE_SHAPE.test(zone)) return null;
  if (!Object.prototype.hasOwnProperty.call(ZONE_COUNTRY, zone)) return null;
  const city = zone.slice(zone.lastIndexOf('/') + 1).replace(/_/g, ' ');
  return { city, country: ZONE_COUNTRY[zone] };
}
