/**
 * Natural Language Query Parser
 * 
 * Parses English natural language queries into structured filters
 * for the profiles endpoint. Rule-based only — no AI/LLMs.
 * 
 * Supported patterns:
 *   - Gender: "male", "males", "female", "females", "men", "women"
 *   - Age groups: "young" (16-24), "teenager"/"teen", "child"/"kid", "adult", "senior"/"elderly"/"old"
 *   - Age ranges: "above N", "over N", "older than N", "below N", "under N", "younger than N"
 *   - Countries: "from <country name>"
 *   - Neutral: "people", "persons", "profiles" (ignored for filtering)
 */

const { findCountryCode } = require("../utils/countries");

/**
 * Parse a natural language query into filter parameters.
 * @param {string} query - The natural language query string
 * @returns {{ filters: object } | { error: string }} - Parsed filters or error
 */
function parseNaturalLanguageQuery(query) {
  if (!query || typeof query !== "string" || query.trim() === "") {
    return { error: "Unable to interpret query" };
  }

  const original = query.trim();
  const q = original.toLowerCase();
  const filters = {};
  let matched = false;

  // --- Gender detection ---
  const hasMale = /\b(male|males|men|man)\b/.test(q);
  const hasFemale = /\b(female|females|women|woman)\b/.test(q);

  if (hasMale && hasFemale) {
    // Both genders mentioned — no gender filter, but it's a valid match
    matched = true;
  } else if (hasMale) {
    filters.gender = "male";
    matched = true;
  } else if (hasFemale) {
    filters.gender = "female";
    matched = true;
  }

  // --- Age group detection ---
  if (/\b(teenager|teenagers|teens?)\b/.test(q)) {
    filters.age_group = "teenager";
    matched = true;
  } else if (/\b(child|children|kids?)\b/.test(q)) {
    filters.age_group = "child";
    matched = true;
  } else if (/\b(adult|adults)\b/.test(q)) {
    filters.age_group = "adult";
    matched = true;
  } else if (/\b(senior|seniors|elderly)\b/.test(q)) {
    filters.age_group = "senior";
    matched = true;
  }

  // --- "Young" keyword: maps to age range 16-24 ---
  if (/\byoung\b/.test(q)) {
    // "young" sets age range 16-24 if no explicit age range is given
    if (!filters.min_age) filters.min_age = 16;
    if (!filters.max_age) filters.max_age = 24;
    matched = true;
  }

  // --- "Old" keyword without specific age: maps to senior ---
  if (/\bold\b/.test(q) && !filters.age_group) {
    filters.age_group = "senior";
    matched = true;
  }

  // --- Age range: "above/over/older than N" ---
  const aboveMatch = q.match(/\b(?:above|over|older than|more than)\s+(\d+)\b/);
  if (aboveMatch) {
    filters.min_age = parseInt(aboveMatch[1], 10);
    matched = true;
  }

  // --- Age range: "below/under/younger than N" ---
  const belowMatch = q.match(/\b(?:below|under|younger than|less than)\s+(\d+)\b/);
  if (belowMatch) {
    filters.max_age = parseInt(belowMatch[1], 10);
    matched = true;
  }

  // --- Age range: "between N and M" ---
  const betweenMatch = q.match(/\bbetween\s+(\d+)\s+and\s+(\d+)\b/);
  if (betweenMatch) {
    filters.min_age = parseInt(betweenMatch[1], 10);
    filters.max_age = parseInt(betweenMatch[2], 10);
    matched = true;
  }

  // --- Age range: "aged N" or "age N" ---
  const agedMatch = q.match(/\b(?:aged?)\s+(\d+)\b/);
  if (agedMatch) {
    filters.min_age = parseInt(agedMatch[1], 10);
    filters.max_age = parseInt(agedMatch[1], 10);
    matched = true;
  }

  // --- Country detection: "from <country>" ---
  const fromMatch = q.match(/\bfrom\s+(.+?)(?:\s+(?:above|over|older|below|under|younger|between|aged?|who|that|with)\b|$)/i);
  if (fromMatch) {
    const countryStr = fromMatch[1].trim();
    const code = findCountryCode(countryStr);
    if (code) {
      filters.country_id = code;
      matched = true;
    }
  }

  // --- Country detection: "in <country>" ---
  if (!filters.country_id) {
    const inMatch = q.match(/\bin\s+(.+?)(?:\s+(?:above|over|older|below|under|younger|between|aged?|who|that|with)\b|$)/i);
    if (inMatch) {
      const countryStr = inMatch[1].trim();
      const code = findCountryCode(countryStr);
      if (code) {
        filters.country_id = code;
        matched = true;
      }
    }
  }

  // --- Neutral words that indicate valid query but no filter ---
  if (/\b(people|persons?|profiles?|users?|everyone|everybody|all)\b/.test(q)) {
    matched = true;
  }

  if (!matched) {
    return { error: "Unable to interpret query" };
  }

  return { filters };
}

module.exports = { parseNaturalLanguageQuery };
