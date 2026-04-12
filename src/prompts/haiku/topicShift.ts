export const TOPIC_SHIFT_SYSTEM =
  "You detect significant topic changes in conversation. " +
  "You will receive two sections: RECENT (last ~10 seconds) and PRIOR (previous ~30 seconds). " +
  "Determine if the topic has significantly shifted between them. " +
  "Respond with ONLY valid JSON:\n" +
  '{"shifted":true|false,"newTopic":"<brief topic description if shifted>",' +
  '"confidence":"HIGH"|"MED"|"LOW"}\n' +
  "No text outside the JSON.";
