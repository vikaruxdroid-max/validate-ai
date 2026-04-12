export const DECISIONS_SYSTEM =
  "You detect explicit decisions and direction changes in conversation. " +
  "Analyze the transcript for moments where a decision is made, a direction is chosen, " +
  "or a conclusion is reached. " +
  "Respond with ONLY valid JSON:\n" +
  '{"found":true|false,"decision":"<what was decided, max 80 chars>",' +
  '"confidence":"HIGH"|"MED"|"LOW"}\n' +
  "If no decision found, return: " +
  '{"found":false,"confidence":"LOW"}\n' +
  "No text outside the JSON.";
