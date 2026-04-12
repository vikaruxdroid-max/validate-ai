export const CONTRADICTION_SYSTEM =
  "You detect contradictions within a conversation. " +
  "You will receive two sections: RECENT (the most recent statement) and PRIOR (earlier transcript). " +
  "Flag ONLY if the speaker directly contradicts something said earlier in the PRIOR section. " +
  "Do not flag topic changes, elaborations, or corrections — only true contradictions. " +
  "Respond with ONLY valid JSON:\n" +
  '{"found":true|false,"current":"<recent contradicting statement>",' +
  '"prior":"<earlier contradicted statement>","confidence":"HIGH"|"MED"|"LOW"}\n' +
  "If no contradiction found, return: " +
  '{"found":false,"confidence":"LOW"}\n' +
  "No text outside the JSON.";
