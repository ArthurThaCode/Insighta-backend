/**
 * Country name to ISO 3166-1 alpha-2 code mapping.
 * Used for natural language query parsing.
 */

const countryNameToCode = {
  // African countries
  "algeria": "DZ",
  "angola": "AO",
  "benin": "BJ",
  "botswana": "BW",
  "burkina faso": "BF",
  "burundi": "BI",
  "cameroon": "CM",
  "cape verde": "CV",
  "central african republic": "CF",
  "chad": "TD",
  "comoros": "KM",
  "congo": "CG",
  "republic of the congo": "CG",
  "dr congo": "CD",
  "democratic republic of the congo": "CD",
  "drc": "CD",
  "cote d'ivoire": "CI",
  "côte d'ivoire": "CI",
  "ivory coast": "CI",
  "djibouti": "DJ",
  "egypt": "EG",
  "equatorial guinea": "GQ",
  "eritrea": "ER",
  "eswatini": "SZ",
  "swaziland": "SZ",
  "ethiopia": "ET",
  "gabon": "GA",
  "gambia": "GM",
  "ghana": "GH",
  "guinea": "GN",
  "guinea-bissau": "GW",
  "guinea bissau": "GW",
  "kenya": "KE",
  "lesotho": "LS",
  "liberia": "LR",
  "libya": "LY",
  "madagascar": "MG",
  "malawi": "MW",
  "mali": "ML",
  "mauritania": "MR",
  "mauritius": "MU",
  "morocco": "MA",
  "mozambique": "MZ",
  "namibia": "NA",
  "niger": "NE",
  "nigeria": "NG",
  "rwanda": "RW",
  "sao tome and principe": "ST",
  "são tomé and príncipe": "ST",
  "senegal": "SN",
  "seychelles": "SC",
  "sierra leone": "SL",
  "somalia": "SO",
  "south africa": "ZA",
  "south sudan": "SS",
  "sudan": "SD",
  "tanzania": "TZ",
  "togo": "TG",
  "tunisia": "TN",
  "uganda": "UG",
  "western sahara": "EH",
  "zambia": "ZM",
  "zimbabwe": "ZW",

  // Other major countries found in the seed data
  "australia": "AU",
  "brazil": "BR",
  "canada": "CA",
  "china": "CN",
  "france": "FR",
  "germany": "DE",
  "india": "IN",
  "japan": "JP",
  "united kingdom": "GB",
  "uk": "GB",
  "united states": "US",
  "usa": "US",
  "us": "US",
};

// Build reverse mapping: code -> name
const countryCodeToName = {};
// Use seed data's exact country_name values as primary names
const primaryNames = {
  "TZ": "Tanzania", "NG": "Nigeria", "UG": "Uganda", "SD": "Sudan",
  "US": "United States", "MG": "Madagascar", "GB": "United Kingdom",
  "IN": "India", "CM": "Cameroon", "CV": "Cape Verde", "CG": "Republic of the Congo",
  "MZ": "Mozambique", "ZA": "South Africa", "ML": "Mali", "AO": "Angola",
  "CD": "DR Congo", "FR": "France", "KE": "Kenya", "ZM": "Zambia",
  "ER": "Eritrea", "GA": "Gabon", "RW": "Rwanda", "SN": "Senegal",
  "NA": "Namibia", "GM": "Gambia", "CI": "Côte d'Ivoire", "ET": "Ethiopia",
  "MA": "Morocco", "MW": "Malawi", "BR": "Brazil", "TN": "Tunisia",
  "SO": "Somalia", "GH": "Ghana", "ZW": "Zimbabwe", "EG": "Egypt",
  "BJ": "Benin", "EH": "Western Sahara", "AU": "Australia", "CN": "China",
  "BW": "Botswana", "CA": "Canada", "LR": "Liberia", "MR": "Mauritania",
  "BI": "Burundi", "BF": "Burkina Faso", "CF": "Central African Republic",
  "MU": "Mauritius", "DZ": "Algeria", "JP": "Japan", "GW": "Guinea-Bissau",
  "SZ": "Eswatini", "SL": "Sierra Leone", "KM": "Comoros", "SC": "Seychelles",
  "SS": "South Sudan", "DE": "Germany", "DJ": "Djibouti", "NE": "Niger",
  "TG": "Togo", "LS": "Lesotho", "TD": "Chad", "ST": "São Tomé and Príncipe",
  "LY": "Libya", "GN": "Guinea", "GQ": "Equatorial Guinea"
};

Object.entries(primaryNames).forEach(([code, name]) => {
  countryCodeToName[code] = name;
});

/**
 * Try to find a country code from a country name string.
 * Returns the ISO code or null.
 */
function findCountryCode(name) {
  if (!name) return null;
  const normalized = name.trim().toLowerCase();

  // Direct lookup
  if (countryNameToCode[normalized]) {
    return countryNameToCode[normalized];
  }

  // Try partial match (e.g., "congo" matches "republic of the congo")
  for (const [countryName, code] of Object.entries(countryNameToCode)) {
    if (countryName.includes(normalized) || normalized.includes(countryName)) {
      return code;
    }
  }

  // Try matching against ISO codes directly (e.g., "NG", "KE")
  const upper = normalized.toUpperCase();
  if (upper.length === 2 && countryCodeToName[upper]) {
    return upper;
  }

  return null;
}

module.exports = { countryNameToCode, countryCodeToName, findCountryCode };
