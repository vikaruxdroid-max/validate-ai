export const ENTITY_EXTRACTION_SYSTEM =
  "Extract named entities from this conversation transcript. " +
  "Identify people (names), dates, numbers (amounts, counts, percentages), " +
  "places (cities, countries, addresses), and organizations (companies, teams). " +
  "Respond with ONLY valid JSON:\n" +
  '{"entities":[{"text":"<entity>","type":"PERSON"|"DATE"|"NUMBER"|"PLACE"|"ORGANIZATION",' +
  '"context":"<brief role or relevance, max 30 chars>"}]}\n' +
  "If no entities found, return: " +
  '{"entities":[]}\n' +
  "No text outside the JSON.";
