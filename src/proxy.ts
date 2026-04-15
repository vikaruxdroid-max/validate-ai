import "dotenv/config";
import { readFileSync, statSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "https";
import { WebSocketServer, WebSocket } from "ws";
import { initDatabase, importJSON, exportJSON, clearAll, computePersonaPatternScores } from "./services/database";

// Server-only env vars. No VITE_* fallbacks — those are browser-bundle names.
// Ensure DEEPGRAM_API_KEY and ANTHROPIC_API_KEY are set in .env on the Linux host.
const DG_KEY = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const DEV_TOKEN = process.env.DEV_TOKEN ?? "";
const DEVICE_RPC_TOKEN = process.env.DEVICE_RPC_TOKEN ?? "";
const PORT = 3001;
const CERT_DIR = "/etc/letsencrypt/live/vikarux-g2.centralus.cloudapp.azure.com";
const MEMORY_PATH = process.env.MEMORY_PATH ?? "/home/vikarux/validate-ai/session-memory.json";
const DB_PATH = process.env.DB_PATH ?? "/home/vikarux/validate-ai/validateai.db";
const ANALYSIS_TIMEOUT_MS = Math.max(120_000, Number(process.env.ANALYSIS_TIMEOUT_MS ?? 120_000));
const ANALYSIS_MAX_TOKENS = Number(process.env.ANALYSIS_MAX_TOKENS ?? 4096);

if (!DG_KEY) {
  console.error("[proxy] DEEPGRAM_API_KEY not set in .env");
  process.exit(1);
}

console.log("[proxy] Deepgram key present:", DG_KEY.length > 0);
console.log("[proxy] Anthropic key present:", ANTHROPIC_KEY.length > 0);
console.log("[proxy] Dev token set:", DEV_TOKEN.length > 0);
console.log("[proxy] Device RPC token set:", DEVICE_RPC_TOKEN.length > 0);
console.log("[proxy] DB path:", DB_PATH);
console.log("[proxy] Analysis timeout:", ANALYSIS_TIMEOUT_MS, "ms");
console.log("[proxy] Analysis max tokens:", ANALYSIS_MAX_TOKENS);

const db = initDatabase(DB_PATH, MEMORY_PATH);

// ── Helpers ───────────────────────────────────────────────────────────

function errBody(error: string, code: string): string {
  return JSON.stringify({ error, code, timestamp: new Date().toISOString() });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ── Server-side Claude caller ─────────────────────────────────────────
// Node.js only. No import.meta.env. No browser-only headers.

type ClaudeCallOptions = {
  model: string;
  maxTokens: number;
  timeoutMs?: number;
};

async function callClaude(
  system: string,
  userMsg: string,
  opts: ClaudeCallOptions,
): Promise<string> {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set in .env");

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system,
        messages: [{ role: "user", content: userMsg }],
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(tid);
    if (err?.name === "AbortError") throw new Error(`Claude timed out after ${timeoutMs}ms`);
    throw err;
  }
  clearTimeout(tid);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const block = json.content?.find((b: any) => b.type === "text");
  if (!block?.text) throw new Error("No text block in Claude response");
  return block.text;
}

// Strips markdown fences and extracts outermost JSON object.
function extractJSON(raw: string): any {
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in response");
  return JSON.parse(match[0]);
}

// Helper: validates a section has supportingArtifactRefs as an array of strings.
function requireArtifactRefs(section: any, name: string): void {
  if (!Array.isArray(section.supportingArtifactRefs)) {
    throw new Error(`${name}.supportingArtifactRefs must be an array`);
  }
  for (let i = 0; i < section.supportingArtifactRefs.length; i++) {
    if (typeof section.supportingArtifactRefs[i] !== "string") {
      throw new Error(`${name}.supportingArtifactRefs[${i}] must be a string`);
    }
  }
}

const CONFIDENCE_VALUES = new Set(["HIGH", "MEDIUM", "LOW"]);
const OBSERVATION_TYPE_VALUES = new Set(["recent", "recurring", "historical"]);

// Validates required sections, nested fields, enum values, array types,
// and supportingArtifactRefs on every non-null section that requires them.
function validateAnalysisShape(obj: any): void {
  if (!obj || typeof obj !== "object") throw new Error("Response is not an object");

  // communicationProfile — always required
  const cp = obj.communicationProfile;
  if (!cp || typeof cp !== "object") throw new Error("Missing communicationProfile");
  if (!CONFIDENCE_VALUES.has(cp.confidence)) throw new Error(`communicationProfile.confidence invalid: ${cp.confidence}`);
  if (typeof cp.sessionCount !== "number") throw new Error("communicationProfile.sessionCount must be a number");
  if (!Array.isArray(cp.topIntents)) throw new Error("communicationProfile.topIntents must be an array");
  requireArtifactRefs(cp, "communicationProfile");

  // dataQuality — always required
  const dq = obj.dataQuality;
  if (!dq || typeof dq !== "object") throw new Error("Missing dataQuality");
  if (typeof dq.totalArtifacts !== "number") throw new Error("dataQuality.totalArtifacts must be a number");
  if (typeof dq.totalSessions !== "number") throw new Error("dataQuality.totalSessions must be a number");
  if (!Array.isArray(dq.limitations)) throw new Error("dataQuality.limitations must be an array");
  if (!Array.isArray(dq.sectionsSuppressed)) throw new Error("dataQuality.sectionsSuppressed must be an array");

  // identityQuality — always required, no artifact refs needed (derived from patternScores)
  const iq = obj.identityQuality;
  if (!iq || typeof iq !== "object") throw new Error("Missing identityQuality");
  if (!CONFIDENCE_VALUES.has(iq.confidence)) throw new Error(`identityQuality.confidence invalid: ${iq.confidence}`);

  // topicsAndBehavior — always required
  const tb = obj.topicsAndBehavior;
  if (!tb || typeof tb !== "object") throw new Error("Missing topicsAndBehavior");
  if (!Array.isArray(tb.frequentTopics)) throw new Error("topicsAndBehavior.frequentTopics must be an array");
  if (!Array.isArray(tb.aboveBaselineHedgingTopics)) throw new Error("topicsAndBehavior.aboveBaselineHedgingTopics must be an array");
  if (!Array.isArray(tb.topicsTheyIntroduce)) throw new Error("topicsAndBehavior.topicsTheyIntroduce must be an array");
  if (!Array.isArray(tb.topicsTheyDeferOn)) throw new Error("topicsAndBehavior.topicsTheyDeferOn must be an array");
  requireArtifactRefs(tb, "topicsAndBehavior");

  // interactionInsights — always required
  const ii = obj.interactionInsights;
  if (!ii || typeof ii !== "object") throw new Error("Missing interactionInsights");
  if (!Array.isArray(ii.effectiveApproaches)) throw new Error("interactionInsights.effectiveApproaches must be an array");
  if (!Array.isArray(ii.watchPoints)) throw new Error("interactionInsights.watchPoints must be an array");
  if (!Array.isArray(ii.suggestedNextSteps)) throw new Error("interactionInsights.suggestedNextSteps must be an array");
  requireArtifactRefs(ii, "interactionInsights");

  // reliabilitySignals — optional (null allowed), validate if present
  if (obj.reliabilitySignals != null) {
    const rs = obj.reliabilitySignals;
    if (typeof rs !== "object") throw new Error("reliabilitySignals must be object or null");
    if (!CONFIDENCE_VALUES.has(rs.confidence)) throw new Error(`reliabilitySignals.confidence invalid: ${rs.confidence}`);
    if (typeof rs.evidenceCount !== "number") throw new Error("reliabilitySignals.evidenceCount must be a number");
    requireArtifactRefs(rs, "reliabilitySignals");
  }

  // likelyInteractionOutcomes — optional (null allowed), validate if present
  if (obj.likelyInteractionOutcomes != null) {
    const lio = obj.likelyInteractionOutcomes;
    if (typeof lio !== "object") throw new Error("likelyInteractionOutcomes must be object or null");
    if (!Array.isArray(lio.conditionalScenarios)) throw new Error("likelyInteractionOutcomes.conditionalScenarios must be an array");
    for (let i = 0; i < lio.conditionalScenarios.length; i++) {
      const s = lio.conditionalScenarios[i];
      if (typeof s.condition !== "string" || !s.condition.trim()) {
        throw new Error(`conditionalScenarios[${i}].condition must be a non-empty string`);
      }
      if (typeof s.likelyOutcome !== "string" || !s.likelyOutcome.trim()) {
        throw new Error(`conditionalScenarios[${i}].likelyOutcome must be a non-empty string`);
      }
      if (typeof s.evidenceCount !== "number") {
        throw new Error(`conditionalScenarios[${i}].evidenceCount must be a number`);
      }
      if (!OBSERVATION_TYPE_VALUES.has(s.observationType)) {
        throw new Error(`conditionalScenarios[${i}].observationType invalid: ${s.observationType}`);
      }
      if (!CONFIDENCE_VALUES.has(s.confidence)) {
        throw new Error(`conditionalScenarios[${i}].confidence invalid: ${s.confidence}`);
      }
    }
    if (!Array.isArray(lio.recommendedApproaches)) throw new Error("likelyInteractionOutcomes.recommendedApproaches must be an array");
    requireArtifactRefs(lio, "likelyInteractionOutcomes");
  }

  // influencePatterns — optional (null allowed), validate if present
  if (obj.influencePatterns != null) {
    const ip = obj.influencePatterns;
    if (typeof ip !== "object") throw new Error("influencePatterns must be object or null");
    if (!CONFIDENCE_VALUES.has(ip.confidence)) throw new Error(`influencePatterns.confidence invalid: ${ip.confidence}`);
    if (typeof ip.evidenceCount !== "number") throw new Error("influencePatterns.evidenceCount must be a number");
    if (!Array.isArray(ip.patternsObserved)) throw new Error("influencePatterns.patternsObserved must be an array");
    requireArtifactRefs(ip, "influencePatterns");
  }
}

// Generic: calls Claude with JSON extraction, caller-provided validation,
// and one repair retry. On repair, the original user msg AND the broken
// response are included. Never throws — returns discriminated union.
async function callClaudeJSON(
  system: string,
  originalUserMsg: string,
  opts: {
    validator: (obj: any) => void;
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
    logTag?: string;
  },
): Promise<{ ok: true; data: any } | { ok: false; error: string; rawResponse?: string }> {
  const {
    validator,
    model = "claude-sonnet-4-5",
    maxTokens = 2048,
    timeoutMs = ANALYSIS_TIMEOUT_MS,
    logTag = "claude-json",
  } = opts;
  const claudeOpts: ClaudeCallOptions = { model, maxTokens, timeoutMs };
  let firstRaw: string | undefined;
  let secondRaw: string | undefined;

  try {
    const raw = await callClaude(system, originalUserMsg, claudeOpts);
    firstRaw = raw;
    const parsed = extractJSON(raw);
    validator(parsed);
    return { ok: true, data: parsed };
  } catch (err: any) {
    console.warn(`[${logTag}] attempt 1 failed:`, err.message);
    if (firstRaw) console.warn(`[${logTag}] attempt 1 raw (500 chars):`, firstRaw.slice(0, 500));
  }

  try {
    const repairMsg =
      `${originalUserMsg}\n\n` +
      `---\n` +
      `Your previous attempt could not be parsed or failed validation.\n\n` +
      `Previous response (first 1000 chars):\n${(firstRaw ?? "").slice(0, 1000)}\n\n` +
      `Return ONLY the corrected JSON object. No markdown fences, no explanation, no text outside the JSON.`;

    const raw2 = await callClaude(system, repairMsg, claudeOpts);
    secondRaw = raw2;
    const parsed2 = extractJSON(raw2);
    validator(parsed2);
    console.log(`[${logTag}] repair attempt succeeded`);
    return { ok: true, data: parsed2 };
  } catch (err2: any) {
    console.error(`[${logTag}] repair attempt also failed:`, err2.message);
    if (secondRaw) console.error(`[${logTag}] attempt 2 raw (500 chars):`, secondRaw.slice(0, 500));
    return { ok: false, error: err2.message, rawResponse: firstRaw?.slice(0, 500) };
  }
}

function callClaudeAnalysis(system: string, originalUserMsg: string) {
  return callClaudeJSON(system, originalUserMsg, {
    validator: validateAnalysisShape,
    maxTokens: ANALYSIS_MAX_TOKENS,
    logTag: "analysis",
  });
}

// Lenient brief validator — briefs have varied fields by isSelf and the
// client has always accepted whatever Claude produced. Just require object.
function validateBriefShape(obj: any): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("Brief response is not a JSON object");
  }
}

// ── Recency weighting ─────────────────────────────────────────────────
// Discrete buckets — explicit and debuggable.

function recencyWeight(createdAt: string): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
  if (ageDays <= 30) return 1.0;
  if (ageDays <= 90) return 0.7;
  if (ageDays <= 180) return 0.4;
  return 0.2;
}

function weightedSort<T extends { created_at: string; importance_score?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const wa = recencyWeight(a.created_at) * (a.importance_score ?? 5);
    const wb = recencyWeight(b.created_at) * (b.importance_score ?? 5);
    return wb - wa;
  });
}

// ── Insufficient-data thresholds ──────────────────────────────────────
const MIN_SESSIONS_FOR_ANALYSIS = 3;
const MIN_ARTIFACTS_FOR_ANALYSIS = 10;
const GLOBAL_ARTIFACT_CAP = 60;

type BuildResult =
  | null
  | { insufficient: true; sessions: number; artifacts: number }
  | { insufficient?: false; persona: any; userMsg: string };

function buildAnalysisPayload(personaId: string): BuildResult {
  const persona = db.prepare("SELECT * FROM personas WHERE id = ?").get(personaId) as any;
  if (!persona) return null;

  const rawCommitments = db.prepare(
    `SELECT id, text, owner, due_date_text, confidence, source_text,
            source_tier, importance_score, status, created_at, session_id
     FROM commitments WHERE persona_id = ?`
  ).all(personaId) as any[];

  const rawDecisions = db.prepare(
    `SELECT id, text, confidence, source_text,
            source_tier, importance_score, created_at, session_id
     FROM decisions WHERE persona_id = ?`
  ).all(personaId) as any[];

  const rawEntities = db.prepare(
    `SELECT id, text, type, context,
            source_tier, importance_score, created_at, session_id
     FROM entities WHERE persona_id = ?`
  ).all(personaId) as any[];

  const rawContradictions = db.prepare(
    `SELECT id, summary, previous_statement, current_statement,
            confidence, source_tier, importance_score, created_at, session_id
     FROM contradictions WHERE persona_id = ?`
  ).all(personaId) as any[];

  const totalPrimaryArtifacts =
    rawCommitments.length + rawDecisions.length +
    rawEntities.length + rawContradictions.length;

  const sidRows = db.prepare(`
    SELECT DISTINCT session_id FROM (
      SELECT session_id FROM commitments WHERE persona_id = ? AND session_id IS NOT NULL
      UNION SELECT session_id FROM decisions WHERE persona_id = ? AND session_id IS NOT NULL
      UNION SELECT session_id FROM entities WHERE persona_id = ? AND session_id IS NOT NULL
      UNION SELECT session_id FROM contradictions WHERE persona_id = ? AND session_id IS NOT NULL
    )
  `).all(personaId, personaId, personaId, personaId) as any[];

  const sids = sidRows.map((r: any) => r.session_id);
  const totalSessions = sids.length;

  if (totalSessions < MIN_SESSIONS_FOR_ANALYSIS || totalPrimaryArtifacts < MIN_ARTIFACTS_FOR_ANALYSIS) {
    return { insufficient: true, sessions: totalSessions, artifacts: totalPrimaryArtifacts };
  }

  type TaggedArtifact = { _type: string; created_at: string; importance_score?: number; [key: string]: any };

  const allRaw: TaggedArtifact[] = [
    ...rawCommitments.map((c) => ({ ...c, _type: "commitment" })),
    ...rawDecisions.map((d) => ({ ...d, _type: "decision" })),
    ...rawEntities.map((e) => ({ ...e, _type: "entity" })),
    ...rawContradictions.map((c) => ({ ...c, _type: "contradiction" })),
  ];

  const allSorted = weightedSort(allRaw).slice(0, GLOBAL_ARTIFACT_CAP);

  const commitments = allSorted.filter((a) => a._type === "commitment");
  const decisions = allSorted.filter((a) => a._type === "decision");
  const entities = allSorted.filter((a) => a._type === "entity");
  const contradictions = allSorted.filter((a) => a._type === "contradiction");

  let sessions: any[] = [];
  if (sids.length > 0) {
    const ph = sids.map(() => "?").join(",");
    sessions = db.prepare(
      `SELECT id, label, started_at, ended_at, status, stats_json FROM sessions WHERE id IN (${ph})`
    ).all(...sids) as any[];
  }

  let contextualCommitments: any[] = [];
  let contextualDecisions: any[] = [];
  if (sids.length > 0) {
    const ph = sids.map(() => "?").join(",");
    contextualCommitments = db.prepare(
      `SELECT text, created_at FROM commitments
       WHERE session_id IN (${ph}) AND (persona_id IS NULL OR persona_id != ?)
       ORDER BY created_at DESC LIMIT 5`
    ).all(...sids, personaId) as any[];

    contextualDecisions = db.prepare(
      `SELECT text, created_at FROM decisions
       WHERE session_id IN (${ph}) AND (persona_id IS NULL OR persona_id != ?)
       ORDER BY created_at DESC LIMIT 5`
    ).all(...sids, personaId) as any[];
  }

  const patternScores = computePersonaPatternScores(db, personaId);

  let signalSnapshots: any[] = [];
  try { signalSnapshots = JSON.parse(persona.signal_snapshots_json || "[]"); } catch { signalSnapshots = []; }

  let aliases: string[] = [];
  try { aliases = JSON.parse(persona.aliases_json || "[]"); } catch { aliases = []; }

  const payload = {
    persona: {
      name: persona.name,
      aliases,
      role: persona.role ?? null,
      company: persona.company ?? null,
      notes: persona.notes ?? null,
      isSelf: persona.is_self === 1,
      firstSeenAt: persona.created_at,
      lastSeenAt: persona.last_seen_at,
    },
    sessions: sessions.map((s) => {
      let stats = {};
      try { stats = JSON.parse(s.stats_json || "{}"); } catch { stats = {}; }
      return { id: s.id, label: s.label, startedAt: s.started_at, endedAt: s.ended_at, status: s.status, stats };
    }),
    primaryArtifacts: {
      attributionNote: "All items below are directly attributed to this persona via persona_id. Use these as primary evidence.",
      commitments: commitments.map((c) => ({
        id: c.id, text: c.text, owner: c.owner ?? null,
        dueDate: c.due_date_text ?? null, confidence: c.confidence ?? null,
        status: c.status, sourceTier: c.source_tier ?? null,
        importanceScore: c.importance_score ?? null,
        recencyWeight: recencyWeight(c.created_at),
        createdAt: c.created_at,
      })),
      decisions: decisions.map((d) => ({
        id: d.id, text: d.text, confidence: d.confidence ?? null,
        sourceTier: d.source_tier ?? null, importanceScore: d.importance_score ?? null,
        recencyWeight: recencyWeight(d.created_at), createdAt: d.created_at,
      })),
      entities: entities.map((e) => ({
        id: e.id, text: e.text, type: e.type, context: e.context ?? null,
        sourceTier: e.source_tier ?? null, importanceScore: e.importance_score ?? null,
        recencyWeight: recencyWeight(e.created_at), createdAt: e.created_at,
      })),
      contradictions: contradictions.map((c) => ({
        id: c.id, summary: c.summary,
        previous: c.previous_statement ?? null, current: c.current_statement ?? null,
        confidence: c.confidence ?? null, sourceTier: c.source_tier ?? null,
        importanceScore: c.importance_score ?? null,
        recencyWeight: recencyWeight(c.created_at), createdAt: c.created_at,
      })),
    },
    contextualArtifacts: {
      attributionNote: "These are from shared sessions but NOT attributed to this persona. Treat as background context only — do not draw behavioral conclusions about this person from these items.",
      commitments: contextualCommitments.map((c) => ({ text: c.text, createdAt: c.created_at })),
      decisions: contextualDecisions.map((d) => ({ text: d.text, createdAt: d.created_at })),
    },
    patternScores,
    signalSnapshots: signalSnapshots.slice(0, 10),
    totalPrimaryArtifacts,
    totalSessions: sessions.length,
  };

  const userMsg = `Persona: ${persona.name}\n\nAnalysis data:\n${JSON.stringify(payload, null, 2)}`;
  return { persona, userMsg };
}

// ── Brief payload builder ─────────────────────────────────────────────
// Simpler than analysis: no insufficiency thresholds (briefs useful even
// with 1 session), only sessions/commitments/entities, commitment status
// surfaced so the model can reason about openCommitments.

type BriefBuildResult = null | { persona: any; userMsg: string; isSelf: boolean };

function buildBriefPayload(personaId: string): BriefBuildResult {
  const persona = db.prepare("SELECT * FROM personas WHERE id = ?").get(personaId) as any;
  if (!persona) return null;

  const topCommits = db.prepare(
    `SELECT text, owner, due_date_text, status, importance_score
     FROM commitments WHERE persona_id = ?
     ORDER BY importance_score DESC LIMIT 20`
  ).all(personaId) as any[];

  const topEntities = db.prepare(
    `SELECT text, type, context, importance_score
     FROM entities WHERE persona_id = ?
     ORDER BY importance_score DESC LIMIT 20`
  ).all(personaId) as any[];

  const sidRows = db.prepare(`
    SELECT DISTINCT session_id FROM (
      SELECT session_id FROM commitments WHERE persona_id = ? AND session_id IS NOT NULL
      UNION SELECT session_id FROM decisions WHERE persona_id = ? AND session_id IS NOT NULL
      UNION SELECT session_id FROM entities WHERE persona_id = ? AND session_id IS NOT NULL
      UNION SELECT session_id FROM contradictions WHERE persona_id = ? AND session_id IS NOT NULL
    )
  `).all(personaId, personaId, personaId, personaId) as any[];

  const sids = sidRows.map((r: any) => r.session_id);

  let sessions: any[] = [];
  if (sids.length > 0) {
    const ph = sids.map(() => "?").join(",");
    sessions = db.prepare(
      `SELECT id, label, started_at, ended_at, stats_json
       FROM sessions WHERE id IN (${ph})
       ORDER BY started_at DESC`
    ).all(...sids) as any[];
  }

  let aliases: string[] = [];
  try { aliases = JSON.parse(persona.aliases_json || "[]"); } catch { aliases = []; }

  let signalSnapshots: any[] = [];
  try { signalSnapshots = JSON.parse(persona.signal_snapshots_json || "[]"); } catch { signalSnapshots = []; }

  const isSelf = persona.is_self === 1;

  const payload = {
    persona: {
      name: persona.name,
      aliases,
      notes: persona.notes ?? null,
      sessionCount: sids.length,
    },
    sessions: sessions.map((s) => {
      let stats: any = {};
      try { stats = JSON.parse(s.stats_json || "{}"); } catch { stats = {}; }
      return { label: s.label, startedAt: s.started_at, endedAt: s.ended_at, stats };
    }),
    commitments: topCommits.map((c) => ({
      text: c.text,
      owner: c.owner ?? null,
      dueDate: c.due_date_text ?? null,
      done: c.status === "done",
      score: c.importance_score ?? 0,
    })),
    entities: topEntities.map((e) => ({
      text: e.text,
      type: e.type,
      context: e.context ?? null,
      score: e.importance_score ?? 0,
    })),
    signalSnapshots: signalSnapshots.slice(0, 10),
  };

  const userMsg = `Person: ${persona.name}\nArtifacts:\n${JSON.stringify(payload)}`;
  return { persona, userMsg, isSelf };
}

// ── Analysis system prompt ────────────────────────────────────────────

const ANALYSIS_SYSTEM = `You are a behavioral intelligence analyst. Generate a structured profile from conversation artifacts.

CRITICAL RULES:
1. Return ONLY a valid JSON object. No markdown fences, no explanation, no text before or after the JSON.
2. Use ONLY primaryArtifacts for behavioral conclusions about this person. contextualArtifacts are session background only — do not draw conclusions about this person from them.
3. Each artifact includes a recencyWeight (1.0 = last 30 days, 0.7 = 31–90 days, 0.4 = 91–180 days, 0.2 = older). Weight your conclusions accordingly — recent patterns matter more than historical ones.
4. Use patternScores gating flags strictly:
   - hasEnoughForReliability false → set reliabilitySignals to null
   - hasEnoughForPatterns false → set aboveBaselineHedgingTopics to empty array
   - hasEnoughForOutcomes false → set likelyInteractionOutcomes to null
   - hasEnoughForInfluence false → set influencePatterns to null
5. patternScores.claimAccuracy.rate is always null by design — do not synthesize a rate. Set claimAccuracyPattern to the attributionNote from patternScores.claimAccuracy.
6. Never fabricate patterns not present in the artifacts. If evidence is thin, say so in dataQuality.limitations.
7. Frame all observations as probabilistic patterns, never character assessments.
8. Every non-null section MUST include a supportingArtifactRefs array containing the artifact IDs (from primaryArtifacts) that support the conclusions in that section. Use the id field from each artifact. If a section has no direct artifact support, set supportingArtifactRefs to an empty array and note the gap in dataQuality.limitations.

ANTI-OVERCLAIMING RULES — these are absolute prohibitions:
9. FORBIDDEN words and phrases — never use any of the following in generated text:
   - lying, lied, liar, deceptive, deception, manipulative, manipulation, untrustworthy, dishonest
   - "likely because", "probably because", "the reason they", "this is because" — no causal storytelling
   - moral judgments: dishonest, trustworthy, good, bad, problematic (as a character label)
   - motive attribution: "they want to", "their goal is", "they are trying to", "they intend to"
   - certainty phrasing: "always does", "never does", "definitely", "certainly", "clearly" (when describing behavior)
10. If evidence supports a concern, describe the observable pattern only. Do not interpret intent or assign blame.
   - BAD: "They are being deceptive about the budget"
   - GOOD: "Contradictions detected on budget-related statements across 2 sessions"

Required JSON schema — return exactly this structure:
{
  "communicationProfile": {
    "dominantStyle": "Informative | Persuasive | Speculative | Deflective | Collaborative",
    "summary": "2-3 sentences on communication style based on artifacts",
    "topIntents": ["up to 3 labels — use patternScores.topIntents if available, else derive from artifacts"],
    "recentVsHistorical": "one sentence comparing recent vs earlier behavior, or null if fewer than 2 sessions",
    "confidence": "HIGH | MEDIUM | LOW",
    "sessionCount": <number from totalSessions>,
    "supportingArtifactRefs": ["artifact id strings"]
  },
  "reliabilitySignals": null,
  "topicsAndBehavior": {
    "frequentTopics": ["up to 6 topics derived from entities"],
    "aboveBaselineHedgingTopics": [],
    "topicsTheyIntroduce": ["topics raised unprompted in artifacts"],
    "topicsTheyDeferOn": ["topics avoided or redirected — only if evident in artifacts"],
    "supportingArtifactRefs": ["artifact id strings"]
  },
  "likelyInteractionOutcomes": null,
  "influencePatterns": null,
  "interactionInsights": {
    "effectiveApproaches": ["what works well — derive from artifacts or leave empty array"],
    "watchPoints": ["things to monitor — derive from contradictions or hedging patterns"],
    "suggestedNextSteps": ["up to 3 concrete next actions grounded in artifacts"],
    "supportingArtifactRefs": ["artifact id strings"]
  },
  "dataQuality": {
    "totalArtifacts": <number from totalPrimaryArtifacts>,
    "totalSessions": <number from totalSessions>,
    "recencyNote": "string describing recency of data based on artifact createdAt dates",
    "limitations": ["list all data gaps, thin evidence areas, or caveats"],
    "sectionsSuppressed": ["names of sections set to null due to insufficient data"]
  },
  "identityQuality": {
    "confidence": "<use patternScores.identityConfidence>",
    "note": "<use patternScores.identityNote>"
  }
}

When reliabilitySignals is not null (hasEnoughForReliability true), use this shape:
{
  "commitmentPattern": "derive from patternScores.commitmentReliability",
  "consistencyPattern": "derive from patternScores.consistency",
  "claimAccuracyPattern": "<copy patternScores.claimAccuracy.attributionNote>",
  "denominatorNote": "<copy patternScores.commitmentReliability.denominatorNote>",
  "confidence": "HIGH | MEDIUM | LOW",
  "evidenceCount": <number>,
  "supportingArtifactRefs": ["artifact id strings"]
}

When likelyInteractionOutcomes is not null (hasEnoughForOutcomes true), use this shape:
{
  "summary": "string",
  "conditionalScenarios": [
    {
      "condition": "IF <situation>",
      "likelyOutcome": "THEN <outcome>",
      "confidence": "HIGH | MEDIUM | LOW",
      "evidenceCount": <number>,
      "observationType": "recent | recurring | historical"
    }
  ],
  "recommendedApproaches": ["up to 3 approaches"],
  "supportingArtifactRefs": ["artifact id strings"]
}

When influencePatterns is not null (hasEnoughForInfluence true), use this shape:
{
  "summary": "string",
  "patternsObserved": ["specific patterns with evidence from artifacts"],
  "confidence": "HIGH | MEDIUM | LOW",
  "evidenceCount": <number>,
  "supportingArtifactRefs": ["artifact id strings"]
}`;

// ── CORS config ───────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";

function setCORSHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Dev-Token, X-Device-Token");
  if (ALLOWED_ORIGIN !== "*") {
    res.setHeader("Vary", "Origin");
  }
}

// ── HTTPS server ──────────────────────────────────────────────────────

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  setCORSHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/memory/save" && req.method === "POST") {
    if (!req.headers["content-type"]?.includes("application/json")) {
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end(errBody("Content-Type must be application/json", "INVALID_CONTENT_TYPE"));
      return;
    }
    readBody(req).then((body) => {
      try {
        const data = JSON.parse(body);
        importJSON(db, data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      } catch (err: any) {
        console.error("[proxy] memory save error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(errBody(err.message, "SAVE_FAILED"));
      }
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(errBody(err.message, "READ_FAILED"));
    });
    return;
  }

  if (req.url === "/memory/load" && req.method === "GET") {
    try {
      const json = exportJSON(db);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(json);
    } catch (err: any) {
      console.error("[proxy] memory load error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(errBody(err.message, "LOAD_FAILED"));
    }
    return;
  }

  if (req.url === "/memory" && req.method === "DELETE") {
    try {
      clearAll(db);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (err: any) {
      console.error("[proxy] memory delete error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(errBody(err.message, "DELETE_FAILED"));
    }
    return;
  }

  const personaMatch = req.url?.match(/^\/api\/persona\/([^/]+)\/(pattern-scores|analysis|brief)$/);
  if (personaMatch) {
    const pid = decodeURIComponent(personaMatch[1]);
    const action = personaMatch[2];

    if (action === "pattern-scores" && req.method === "GET") {
      try {
        const scores = computePersonaPatternScores(db, pid);
        if (!scores) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(errBody("Persona not found", "NOT_FOUND"));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(scores));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(errBody(err.message, "PATTERN_SCORE_ERROR"));
      }
      return;
    }

    if (action === "analysis" && req.method === "GET") {
      try {
        const row = db.prepare("SELECT analysis_json FROM personas WHERE id = ?").get(pid) as any;
        if (!row) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(errBody("Persona not found", "NOT_FOUND"));
          return;
        }
        if (!row.analysis_json) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("null");
          return;
        }
        let stored: any;
        try {
          stored = JSON.parse(row.analysis_json);
        } catch (parseErr: any) {
          console.error(`[analysis] malformed analysis_json for ${pid}:`, parseErr.message);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            data: null,
            generatedAt: null,
            failed: true,
            error: "Stored analysis is malformed and cannot be read. Re-run analysis to regenerate.",
            code: "CACHE_PARSE_ERROR",
          }));
          return;
        }
        const isLegacy = stored.communicationProfile != null && stored.data === undefined && stored.failed == null;
        const resolvedData = isLegacy ? stored : (stored.data ?? null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: resolvedData,
          generatedAt: stored.generatedAt ?? null,
          failed: isLegacy ? false : (stored.failed ?? false),
          error: isLegacy ? null : (stored.error ?? null),
        }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(errBody(err.message, "ANALYSIS_READ_ERROR"));
      }
      return;
    }

    if (action === "analysis" && req.method === "POST") {
      const built = buildAnalysisPayload(pid);
      if (!built) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(errBody("Persona not found", "NOT_FOUND"));
        return;
      }
      if ("insufficient" in built && built.insufficient) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Insufficient data for analysis",
          code: "INSUFFICIENT_DATA",
          sessions: built.sessions,
          artifacts: built.artifacts,
          required: { sessions: MIN_SESSIONS_FOR_ANALYSIS, artifacts: MIN_ARTIFACTS_FOR_ANALYSIS },
          timestamp: new Date().toISOString(),
        }));
        return;
      }

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end('{"ok":true,"status":"generating"}');

      const { persona, userMsg } = built as { persona: any; userMsg: string };
      console.log(`[analysis] generating for ${pid} (${persona.name}), payload: ${userMsg.length} chars`);

      callClaudeAnalysis(ANALYSIS_SYSTEM, userMsg).then((result) => {
        if (!result.ok) {
          const existing = db.prepare("SELECT analysis_json FROM personas WHERE id = ?").get(pid) as any;
          let hasGoodCache = false;
          if (existing?.analysis_json) {
            try {
              const cached = JSON.parse(existing.analysis_json);
              const envelopeGood = cached?.data != null && !cached?.failed;
              const legacyGood = cached?.communicationProfile != null && cached?.failed == null;
              hasGoodCache = envelopeGood || legacyGood;
            } catch { hasGoodCache = false; }
          }
          if (hasGoodCache) {
            console.warn(`[analysis] failed for ${pid} — existing cache preserved`);
          } else {
            const failRecord = JSON.stringify({
              failed: true,
              error: result.error,
              rawResponse: result.rawResponse ?? null,
              generatedAt: new Date().toISOString(),
              data: null,
            });
            db.prepare("UPDATE personas SET analysis_json = ? WHERE id = ?").run(failRecord, pid);
            console.error(`[analysis] failed for ${pid}, no cache to preserve:`, result.error);
          }
          return;
        }
        const record = JSON.stringify({
          data: result.data,
          generatedAt: new Date().toISOString(),
          failed: false,
          error: null,
        });
        db.prepare("UPDATE personas SET analysis_json = ? WHERE id = ?").run(record, pid);
        console.log(`[analysis] stored for ${pid} (${persona.name})`);
      }).catch((err) => {
        console.error(`[analysis] unexpected error for ${pid}:`, err.message);
      });

      return;
    }

    if (action === "brief" && req.method === "GET") {
      try {
        const row = db.prepare("SELECT brief_json FROM personas WHERE id = ?").get(pid) as any;
        if (!row) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(errBody("Persona not found", "NOT_FOUND"));
          return;
        }
        if (!row.brief_json) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("null");
          return;
        }
        let stored: any;
        try {
          stored = JSON.parse(row.brief_json);
        } catch (parseErr: any) {
          console.error(`[brief] malformed brief_json for ${pid}:`, parseErr.message);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            data: null,
            generatedAt: null,
            failed: true,
            error: "Stored brief is malformed and cannot be read. Re-run brief to regenerate.",
            code: "CACHE_PARSE_ERROR",
          }));
          return;
        }
        // Legacy: raw brief written by old client code had openCommitments at root
        // with no {data, failed} envelope.
        const isLegacy = stored.openCommitments != null && stored.data === undefined && stored.failed == null;
        const resolvedData = isLegacy ? stored : (stored.data ?? null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: resolvedData,
          generatedAt: stored.generatedAt ?? null,
          failed: isLegacy ? false : (stored.failed ?? false),
          error: isLegacy ? null : (stored.error ?? null),
        }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(errBody(err.message, "BRIEF_READ_ERROR"));
      }
      return;
    }

    if (action === "brief" && req.method === "POST") {
      const built = buildBriefPayload(pid);
      if (!built) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(errBody("Persona not found", "NOT_FOUND"));
        return;
      }

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end('{"ok":true,"status":"generating"}');

      const { persona, userMsg, isSelf } = built;
      const system = isSelf
        ? `You generate a personal intelligence summary for a user reviewing their own conversation history.

ATTRIBUTION: All artifacts provided are directly attributed to this person. Base all observations only on what is in the artifacts.

ANTI-OVERCLAIMING RULES:
- Only report patterns that are directly evidenced in the artifacts
- If data is thin, say so explicitly in the summary fields
- Do not invent activity or interactions not present in the artifacts
- Keep all observations factual and artifact-grounded

Return ONLY valid JSON with fields: recentActivity (string), openCommitments (string[]), peopleYouInteractWith (array of {name, count}), communicationPatterns (string), whatChangedRecently (string), suggestedFollowUps (string[]).`
        : `You analyze conversation artifacts about a person and generate a structured pre-conversation brief. Focus on actionable insights. Be concise.

ATTRIBUTION: All artifacts provided are directly attributed to this person via persona_id. Base all observations only on what is in the artifacts.

ANTI-OVERCLAIMING RULES — absolute prohibitions:
- Never use: lying, deceptive, manipulative, untrustworthy, dishonest
- Never use causal language: likely because, probably because, the reason they, this is because
- Never attribute motives: they want to, their goal is, they are trying to, they intend to
- Never use certainty phrasing: always does, never does, definitely, certainly, clearly
- If data is thin (fewer than 3 sessions or 10 artifacts), note this explicitly in signals and keep observations conservative
- Frame all observations as patterns observed in artifacts, never character assessments

Return ONLY valid JSON with fields: who (string), lastInteraction (string), openCommitments (string[]), openQuestions (string[]), signals (string[]), behavioralPatterns (array of {signal, observation, confidence, evidenceCount, caveat}), suggestedFollowUps (string[]), nextSteps (string[]).`;

      console.log(`[brief] generating for ${pid} (${persona.name}), isSelf: ${isSelf}, payload: ${userMsg.length} chars`);

      callClaudeJSON(system, userMsg, {
        validator: validateBriefShape,
        maxTokens: 1024,
        logTag: "brief",
      }).then((result) => {
        if (!result.ok) {
          const existing = db.prepare("SELECT brief_json FROM personas WHERE id = ?").get(pid) as any;
          let hasGoodCache = false;
          if (existing?.brief_json) {
            try {
              const cached = JSON.parse(existing.brief_json);
              const envelopeGood = cached?.data != null && !cached?.failed;
              const legacyGood = cached?.openCommitments != null && cached?.failed == null;
              hasGoodCache = envelopeGood || legacyGood;
            } catch { hasGoodCache = false; }
          }
          if (hasGoodCache) {
            console.warn(`[brief] failed for ${pid} — existing cache preserved`);
          } else {
            const failRecord = JSON.stringify({
              failed: true,
              error: result.error,
              rawResponse: result.rawResponse ?? null,
              generatedAt: new Date().toISOString(),
              data: null,
            });
            db.prepare("UPDATE personas SET brief_json = ? WHERE id = ?").run(failRecord, pid);
            console.error(`[brief] failed for ${pid}, no cache to preserve:`, result.error);
          }
          return;
        }
        // Match the shape the client-side code used to write so existing
        // display logic still works: spread Claude output, add generatedAt
        // (Date.now() number — PersonaBrief type) and type label.
        const briefData = {
          ...result.data,
          generatedAt: Date.now(),
          type: isSelf ? "self_summary" : "standard",
        };
        const record = JSON.stringify({
          data: briefData,
          generatedAt: new Date().toISOString(),
          failed: false,
          error: null,
        });
        db.prepare("UPDATE personas SET brief_json = ? WHERE id = ?").run(record, pid);
        console.log(`[brief] stored for ${pid} (${persona.name})`);
      }).catch((err) => {
        console.error(`[brief] unexpected error for ${pid}:`, err.message);
      });

      return;
    }
  }

  if (req.url === "/api/rpc" && req.method === "POST") {
    const isLocal =
      req.socket.remoteAddress === "127.0.0.1" ||
      req.socket.remoteAddress === "::1" ||
      req.socket.remoteAddress === "::ffff:127.0.0.1";
    const tokenHeader = req.headers["x-device-token"];
    const hasValidToken = DEVICE_RPC_TOKEN.length > 0
      ? tokenHeader === DEVICE_RPC_TOKEN
      : isLocal;

    if (!hasValidToken) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        op: null,
        data: null,
        error: "unauthorized",
        code: "RPC_AUTH",
        degraded: false,
      }));
      return;
    }

    readBody(req).then(async (rawBody) => {
      let envelope: any;
      try {
        envelope = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false, op: null, data: null,
          error: "malformed JSON body", code: "RPC_BAD_REQUEST", degraded: false,
        }));
        return;
      }

      const op = envelope?.op;
      const context = envelope?.context;
      const sessionId = envelope?.sessionId ?? null;
      const personaId = envelope?.personaId ?? null;

      if (typeof op !== "string" || op.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false, op: null, data: null,
          error: "op must be a non-empty string", code: "RPC_BAD_REQUEST", degraded: false,
        }));
        return;
      }
      if (!context || typeof context !== "object" || Array.isArray(context)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false, op, data: null,
          error: "context must be an object", code: "RPC_BAD_REQUEST", degraded: false,
        }));
        return;
      }
      if (sessionId !== null && typeof sessionId !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false, op, data: null,
          error: "sessionId must be string or null", code: "RPC_BAD_REQUEST", degraded: false,
        }));
        return;
      }
      if (personaId !== null && typeof personaId !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false, op, data: null,
          error: "personaId must be string or null", code: "RPC_BAD_REQUEST", degraded: false,
        }));
        return;
      }

      // ── Wave 1 op: recall_memory ─────────────────────────────────
      if (op === "recall_memory") {
        const query = context.query;
        if (typeof query !== "string" || query.trim().length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: false, op, data: null,
            error: "context.query must be a non-empty string",
            code: "RPC_BAD_REQUEST", degraded: false,
          }));
          return;
        }

        let hits: any[] = [];
        try {
          hits = db.prepare(
            `SELECT id, type, text FROM search_index
             WHERE search_index MATCH ?
             ORDER BY bm25(search_index)
             LIMIT 10`
          ).all(query) as any[];
        } catch (err: any) {
          // FTS5 MATCH can throw on malformed query syntax — treat as zero hits
          console.warn(`[rpc] recall_memory FTS error for query ${JSON.stringify(query)}:`, err.message);
          hits = [];
        }

        if (hits.length === 0) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true, op, data: { found: false, matches: [], context: null },
            error: null, code: null, degraded: false,
          }));
          return;
        }

        const shortlist = hits.map((h) => ({ id: h.id, type: h.type, text: h.text }));
        const system = "You are a memory recall assistant. Given a search query and a list of matching conversation artifacts, synthesize a helpful recall response. Be concise and factual. Return ONLY valid JSON: { found: true, matches: [{id, type, text}], context: string }";
        const userMsg = `Query: ${query}\n\nMatching artifacts:\n${JSON.stringify(shortlist)}`;

        console.log(`[rpc] recall_memory: ${hits.length} FTS hits for query ${JSON.stringify(query.slice(0, 60))}`);

        try {
          const raw = await callClaude(system, userMsg, {
            model: "claude-haiku-4-5-20251001",
            maxTokens: 512,
            timeoutMs: 10_000,
          });
          let parsed: any;
          try {
            parsed = extractJSON(raw);
          } catch (parseErr: any) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ok: false, op, data: null,
              error: `could not parse Claude response: ${parseErr.message}`,
              code: "RPC_VALIDATION_FAILED", degraded: false,
            }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true, op, data: parsed,
            error: null, code: null, degraded: false,
          }));
        } catch (err: any) {
          console.error(`[rpc] recall_memory Claude error:`, err.message);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: false, op, data: null,
            error: err.message, code: "RPC_CLAUDE_ERROR", degraded: false,
          }));
        }
        return;
      }

      // Unknown op
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false, op, data: null,
        error: "unknown operation", code: "RPC_UNKNOWN_OP", degraded: false,
      }));
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false, op: null, data: null,
        error: err?.message ?? "read error", code: "RPC_INTERNAL", degraded: false,
      }));
    });
    return;
  }

  if (req.url?.startsWith("/api/dev/")) {
    const isLocal =
      req.socket.remoteAddress === "127.0.0.1" ||
      req.socket.remoteAddress === "::1" ||
      req.socket.remoteAddress === "::ffff:127.0.0.1";
    const tokenHeader = req.headers["x-dev-token"];
    const hasValidToken = DEV_TOKEN.length > 0 && tokenHeader === DEV_TOKEN;

    if (!isLocal && !hasValidToken) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(errBody("Dev endpoint unavailable", "FORBIDDEN"));
      return;
    }

    if (req.url === "/api/dev/stats" && req.method === "GET") {
      try {
        const counts = {
          sessions: (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as any).n,
          commitments: (db.prepare("SELECT COUNT(*) as n FROM commitments").get() as any).n,
          decisions: (db.prepare("SELECT COUNT(*) as n FROM decisions").get() as any).n,
          entities: (db.prepare("SELECT COUNT(*) as n FROM entities").get() as any).n,
          contradictions: (db.prepare("SELECT COUNT(*) as n FROM contradictions").get() as any).n,
          personas: (db.prepare("SELECT COUNT(*) as n FROM personas").get() as any).n,
          selfPersonas: (db.prepare("SELECT COUNT(*) as n FROM personas WHERE is_self=1").get() as any).n,
          pinnedItems: (db.prepare("SELECT COUNT(*) as n FROM pinned_items").get() as any).n,
        };
        let dbSizeBytes = 0;
        try { dbSizeBytes = statSync(DB_PATH).size; } catch { /* file may not exist */ }
        const dbSizeFormatted = dbSizeBytes > 1_048_576
          ? (dbSizeBytes / 1_048_576).toFixed(1) + " MB"
          : (dbSizeBytes / 1024).toFixed(1) + " KB";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...counts, dbSizeBytes, dbSizeFormatted }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.url === "/api/dev/export" && req.method === "GET") {
      try {
        const result: any = { exported_at: new Date().toISOString() };
        result.sessions = db.prepare("SELECT * FROM sessions").all();
        result.commitments = db.prepare("SELECT * FROM commitments").all();
        result.decisions = db.prepare("SELECT * FROM decisions").all();
        result.entities = db.prepare("SELECT * FROM entities").all();
        result.contradictions = db.prepare("SELECT * FROM contradictions").all();
        result.personas = db.prepare("SELECT * FROM personas").all();
        result.pinned_items = db.prepare("SELECT * FROM pinned_items").all();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result, null, 2));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.url === "/api/dev/reset" && req.method === "DELETE") {
      readBody(req).then((body) => {
        try {
          const parsed = JSON.parse(body || "{}");
          if (parsed.confirm !== "RESET") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(errBody("confirm field must be exactly RESET", "INVALID_CONFIRM"));
            return;
          }
          clearAll(db);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ cleared: true, timestamp: new Date().toISOString() }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }
  }

  res.writeHead(404);
  res.end();
}

const httpsServer = createServer(
  {
    cert: readFileSync(`${CERT_DIR}/fullchain.pem`),
    key: readFileSync(`${CERT_DIR}/privkey.pem`),
  },
  handleRequest,
);

const wss = new WebSocketServer({ server: httpsServer });

httpsServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[proxy] listening on wss://0.0.0.0:${PORT}`);
});

// ── Deepgram WebSocket relay ──────────────────────────────────────────

wss.on("connection", (browser) => {
  const dgUrl =
    "wss://api.deepgram.com/v1/listen" +
    "?encoding=linear16&sample_rate=16000&channels=1" +
    "&punctuate=true&interim_results=true&utterance_end_ms=1500";

  const headers = { Authorization: `Token ${DG_KEY}` };

  console.log("[proxy] new connection, relaying to Deepgram");

  const dg = new WebSocket(dgUrl, { headers });
  dg.binaryType = "arraybuffer";

  dg.on("message", (data, isBinary) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary });
  });

  browser.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (dg.readyState === WebSocket.OPEN) dg.send(buf);
  });

  dg.on("close", () => {
    if (browser.readyState === WebSocket.OPEN) browser.close();
  });

  dg.on("error", (err) => {
    console.error("[proxy] Deepgram ERROR:", err.message);
  });

  dg.on("unexpected-response", (_req, dgRes) => {
    let body = "";
    dgRes.on("data", (chunk: Buffer) => (body += chunk.toString()));
    dgRes.on("end", () => console.error("[proxy] Deepgram HTTP", dgRes.statusCode, "—", body));
  });

  browser.on("close", () => {
    if (dg.readyState === WebSocket.OPEN) dg.close();
  });

  browser.on("error", (err) => {
    console.error("[proxy] browser ERROR:", err.message);
  });
});
