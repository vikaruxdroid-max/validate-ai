import Database from "better-sqlite3";
import { existsSync, readFileSync, renameSync } from "fs";
import { dirname, join } from "path";

const SCHEMA_VERSION = 4;

// ── Schema ──────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  stats_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  persona_id TEXT,
  text TEXT NOT NULL,
  owner TEXT,
  due_date_text TEXT,
  confidence TEXT,
  source_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  persona_id TEXT,
  text TEXT NOT NULL,
  confidence TEXT,
  source_text TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  persona_id TEXT,
  text TEXT NOT NULL,
  type TEXT NOT NULL,
  context TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS contradictions (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  persona_id TEXT,
  summary TEXT NOT NULL,
  previous_statement TEXT,
  current_statement TEXT,
  confidence TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS pinned_items (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  persona_id TEXT,
  text TEXT NOT NULL,
  type TEXT,
  source_text TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  role TEXT,
  company TEXT,
  signal_snapshots_json TEXT NOT NULL DEFAULT '[]',
  brief_json TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_commitments_session ON commitments(session_id);
CREATE INDEX IF NOT EXISTS idx_commitments_persona ON commitments(persona_id);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_persona ON decisions(persona_id);
CREATE INDEX IF NOT EXISTS idx_entities_session ON entities(session_id);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_persona ON entities(persona_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_session ON contradictions(session_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_persona ON contradictions(persona_id);
CREATE INDEX IF NOT EXISTS idx_personas_name ON personas(name);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  id UNINDEXED,
  type UNINDEXED,
  text,
  persona_id UNINDEXED,
  session_id UNINDEXED,
  content='',
  contentless_delete=1
);
`;

// FTS sync triggers — one set per artifact table
const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS fts_commitments_insert AFTER INSERT ON commitments BEGIN
  INSERT INTO search_index(id, type, text, persona_id, session_id) VALUES (NEW.id, 'commitment', NEW.text, NEW.persona_id, NEW.session_id);
END;
CREATE TRIGGER IF NOT EXISTS fts_commitments_delete AFTER DELETE ON commitments BEGIN
  INSERT INTO search_index(search_index, id, type, text, persona_id, session_id) VALUES ('delete', OLD.id, 'commitment', OLD.text, OLD.persona_id, OLD.session_id);
END;

CREATE TRIGGER IF NOT EXISTS fts_decisions_insert AFTER INSERT ON decisions BEGIN
  INSERT INTO search_index(id, type, text, persona_id, session_id) VALUES (NEW.id, 'decision', NEW.text, NEW.persona_id, NEW.session_id);
END;
CREATE TRIGGER IF NOT EXISTS fts_decisions_delete AFTER DELETE ON decisions BEGIN
  INSERT INTO search_index(search_index, id, type, text, persona_id, session_id) VALUES ('delete', OLD.id, 'decision', OLD.text, OLD.persona_id, OLD.session_id);
END;

CREATE TRIGGER IF NOT EXISTS fts_entities_insert AFTER INSERT ON entities BEGIN
  INSERT INTO search_index(id, type, text, persona_id, session_id) VALUES (NEW.id, 'entity', NEW.text || ' ' || COALESCE(NEW.context, ''), NEW.persona_id, NEW.session_id);
END;
CREATE TRIGGER IF NOT EXISTS fts_entities_delete AFTER DELETE ON entities BEGIN
  INSERT INTO search_index(search_index, id, type, text, persona_id, session_id) VALUES ('delete', OLD.id, 'entity', OLD.text || ' ' || COALESCE(OLD.context, ''), OLD.persona_id, OLD.session_id);
END;

CREATE TRIGGER IF NOT EXISTS fts_contradictions_insert AFTER INSERT ON contradictions BEGIN
  INSERT INTO search_index(id, type, text, persona_id, session_id) VALUES (NEW.id, 'contradiction', NEW.summary, NEW.persona_id, NEW.session_id);
END;
CREATE TRIGGER IF NOT EXISTS fts_contradictions_delete AFTER DELETE ON contradictions BEGIN
  INSERT INTO search_index(search_index, id, type, text, persona_id, session_id) VALUES ('delete', OLD.id, 'contradiction', OLD.summary, OLD.persona_id, OLD.session_id);
END;

CREATE TRIGGER IF NOT EXISTS fts_pinned_insert AFTER INSERT ON pinned_items BEGIN
  INSERT INTO search_index(id, type, text, persona_id, session_id) VALUES (NEW.id, 'pinned', NEW.text, NEW.persona_id, NEW.session_id);
END;
CREATE TRIGGER IF NOT EXISTS fts_pinned_delete AFTER DELETE ON pinned_items BEGIN
  INSERT INTO search_index(search_index, id, type, text, persona_id, session_id) VALUES ('delete', OLD.id, 'pinned', OLD.text, OLD.persona_id, OLD.session_id);
END;
`;

// ── Init ─────────────────────────────────────────────────────────────

export function initDatabase(dbPath: string, jsonPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(SCHEMA);
  db.exec(FTS_TRIGGERS);

  const version = getSchemaVersion(db);
  if (version === 0) {
    migrateFromJSON(db, jsonPath);
    setSchemaVersion(db, SCHEMA_VERSION);
  } else if (version < SCHEMA_VERSION) {
    runMigrations(db, version);
    setSchemaVersion(db, SCHEMA_VERSION);
  }

  return db;
}

function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any;
    return row ? parseInt(row.value, 10) : 0;
  } catch { return 0; }
}

function setSchemaVersion(db: Database.Database, v: number): void {
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(String(v));
}

// ── Incremental Migrations ───────────────────────────────────────────

function runMigrations(db: Database.Database, fromVersion: number): void {
  if (fromVersion < 2) migrateV1toV2(db);
  if (fromVersion < 3) migrateV2toV3(db);
  if (fromVersion < 4) migrateV3toV4(db);
}

function migrateV1toV2(db: Database.Database): void {
  console.log("[db] Running migration v1 → v2: evidence quality scoring columns");
  const alterStatements = [
    "ALTER TABLE commitments ADD COLUMN source_tier TEXT DEFAULT 'INFERRED'",
    "ALTER TABLE commitments ADD COLUMN importance_score INTEGER DEFAULT 5",
    "ALTER TABLE commitments ADD COLUMN confirmation_count INTEGER DEFAULT 1",
    "ALTER TABLE decisions ADD COLUMN source_tier TEXT DEFAULT 'INFERRED'",
    "ALTER TABLE decisions ADD COLUMN importance_score INTEGER DEFAULT 5",
    "ALTER TABLE decisions ADD COLUMN confirmation_count INTEGER DEFAULT 1",
    "ALTER TABLE entities ADD COLUMN source_tier TEXT DEFAULT 'INFERRED'",
    "ALTER TABLE entities ADD COLUMN importance_score INTEGER DEFAULT 3",
    "ALTER TABLE entities ADD COLUMN confirmation_count INTEGER DEFAULT 1",
    "ALTER TABLE contradictions ADD COLUMN source_tier TEXT DEFAULT 'STATED'",
    "ALTER TABLE contradictions ADD COLUMN importance_score INTEGER DEFAULT 8",
    "ALTER TABLE contradictions ADD COLUMN confirmation_count INTEGER DEFAULT 1",
  ];
  for (const sql of alterStatements) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
  console.log("[db] Migration v1 → v2 complete");
}

function migrateV2toV3(db: Database.Database): void {
  console.log("[db] Running migration v2 → v3: ensure is_self column on personas");
  try { db.exec("ALTER TABLE personas ADD COLUMN is_self INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  console.log("[db] Migration v2 → v3 complete");
}

function migrateV3toV4(db: Database.Database): void {
  console.log("[db] Running migration v3 → v4: add analysis_json column");
  try { db.exec("ALTER TABLE personas ADD COLUMN analysis_json TEXT"); } catch { /* already exists */ }
  console.log("[db] Migration v3 → v4 complete");
}

// ── Pattern Scoring ─────────────────────────────────────────────────

export function computePersonaPatternScores(db: Database.Database, personaId: string): any {
  const persona = db.prepare("SELECT * FROM personas WHERE id = ?").get(personaId) as any;
  if (!persona) return null;

  // Gather all artifacts for this persona
  const commitments = db.prepare("SELECT * FROM commitments WHERE persona_id = ?").all(personaId) as any[];
  const decisions = db.prepare("SELECT * FROM decisions WHERE persona_id = ?").all(personaId) as any[];
  const entities = db.prepare("SELECT * FROM entities WHERE persona_id = ?").all(personaId) as any[];
  const contradictions = db.prepare("SELECT * FROM contradictions WHERE persona_id = ?").all(personaId) as any[];

  // Session info
  const sessionIds = db.prepare(`
    SELECT DISTINCT session_id FROM (
      SELECT session_id FROM commitments WHERE persona_id = ? AND session_id IS NOT NULL
      UNION SELECT session_id FROM decisions WHERE persona_id = ? AND session_id IS NOT NULL
      UNION SELECT session_id FROM entities WHERE persona_id = ? AND session_id IS NOT NULL
      UNION SELECT session_id FROM contradictions WHERE persona_id = ? AND session_id IS NOT NULL
    )
  `).all(personaId, personaId, personaId, personaId) as any[];
  const sids = sessionIds.map((r: any) => r.session_id);
  const totalSessions = sids.length;

  let sessions: any[] = [];
  if (sids.length > 0) {
    const placeholders = sids.map(() => "?").join(",");
    sessions = db.prepare(`SELECT * FROM sessions WHERE id IN (${placeholders})`).all(...sids) as any[];
  }

  const totalArtifacts = commitments.length + decisions.length + entities.length + contradictions.length;

  // Commitment reliability
  let commitmentReliability = null;
  if (commitments.length > 0) {
    const doneCount = commitments.filter((c: any) => c.status === "done").length;
    const overdueCount = commitments.filter((c: any) => c.status !== "done" && c.due_date_text && new Date(c.due_date_text).getTime() < Date.now()).length;
    const pendingCount = commitments.filter((c: any) => c.status !== "done").length - overdueCount;
    const undatedCount = commitments.filter((c: any) => !c.due_date_text).length;
    const dated = commitments.filter((c: any) => c.due_date_text);
    const datedDone = dated.filter((c: any) => c.status === "done").length;
    const datedTotal = dated.length;
    const denomQ = datedTotal >= 5 ? "strong" : datedTotal >= 2 ? "weak" : "insufficient";
    commitmentReliability = {
      rate: datedTotal >= 2 ? Math.round(datedDone / datedTotal * 100) / 100 : null,
      doneCount, pendingCount, overdueCount, undatedCount,
      denominatorQuality: denomQ,
      denominatorNote: denomQ === "strong" ? "Based on " + datedTotal + " dated commitments" :
        denomQ === "weak" ? "Only " + datedTotal + " dated commitments — rate may not be representative" :
        "Fewer than 2 dated commitments — rate cannot be computed reliably",
    };
  }

  // Claim accuracy — only from fact-related pinned items or contradictions with verdicts
  // RULE: return null rate if fewer than 3 clearly persona-attributed facts
  const claimAccuracy = { supportedCount: 0, disputedCount: 0, partialCount: 0, unresolvedCount: 0,
    rate: null as number | null,
    attributionNote: "Claim accuracy requires explicitly persona-attributed fact artifacts. Current schema does not store fact-check verdicts per-persona — this metric will populate when fact artifacts gain persona_id attribution." };

  // Consistency
  let consistency = null;
  if (totalSessions >= 2) {
    const contradictionCount = contradictions.length;
    const contradictionDensity = totalSessions > 0 ? Math.round(contradictionCount / totalSessions * 100) / 100 : null;
    const index = contradictionCount === 0 ? 1.0 : Math.max(0, 1.0 - (contradictionCount * 0.15));
    consistency = {
      index: Math.round(index * 100) / 100, contradictionCount, contradictionDensity,
      repeatedTopicInconsistencies: 0,
      attributionNote: contradictionCount > 0 ? "Based on " + contradictionCount + " contradictions across " + totalSessions + " sessions" : "No contradictions detected",
    };
  }

  // Intent distribution from signal snapshots
  const snaps = JSON.parse(persona.signal_snapshots_json || "[]") as any[];
  let intentDistribution: Record<string, number> | null = null;
  const topIntents: string[] = [];
  const allIntents: Record<string, number> = {};
  for (const s of snaps) {
    if (s.intentCounts) for (const [k, v] of Object.entries(s.intentCounts)) allIntents[k] = (allIntents[k] || 0) + (v as number);
  }
  if (Object.keys(allIntents).length > 0) {
    intentDistribution = allIntents;
    const sorted = Object.entries(allIntents).sort((a, b) => b[1] - a[1]);
    topIntents.push(...sorted.slice(0, 3).map(e => e[0]));
  }

  // Hedging
  const allHedging: number[] = [];
  for (const s of snaps) if (s.hedgingScores) allHedging.push(...s.hedgingScores);
  const avgHedgingScore = allHedging.length >= 2 ? Math.round(allHedging.reduce((a: number, b: number) => a + b, 0) / allHedging.length * 100) / 100 : null;
  let hedgingTrend = null;
  if (allHedging.length >= 4) {
    const mid = Math.floor(allHedging.length / 2);
    const historical = allHedging.slice(0, mid);
    const recent = allHedging.slice(mid);
    const histAvg = historical.reduce((a, b) => a + b, 0) / historical.length;
    const recAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const delta = recAvg - histAvg;
    hedgingTrend = {
      direction: (delta > 0.5 ? "increasing" : delta < -0.5 ? "decreasing" : "stable") as "increasing" | "decreasing" | "stable",
      recentAvg: Math.round(recAvg * 100) / 100,
      historicalAvg: Math.round(histAvg * 100) / 100,
      dataPoints: allHedging.length,
    };
  }

  // Evasion topic map — null for now (requires per-topic hedging correlation not available in current schema)
  const evasionTopicMap = null;

  // Activity trend
  let recentVsHistoricalActivity = null;
  if (sessions.length >= 4) {
    const mid = Math.floor(sessions.length / 2);
    const recentCount = mid;
    const histCount = sessions.length - mid;
    recentVsHistoricalActivity = recentCount > histCount ? "increasing" : recentCount < histCount ? "decreasing" : "stable";
  }

  // Identity confidence
  const isSelf = persona.is_self === 1;
  const identityConfidence = isSelf ? "HIGH" : totalSessions >= 5 ? "HIGH" : totalSessions >= 2 ? "MEDIUM" : "LOW";
  const identityNote = isSelf ? "Self-identified persona" :
    identityConfidence === "HIGH" ? "Consistent name match across " + totalSessions + " sessions" :
    identityConfidence === "MEDIUM" ? totalSessions + " sessions with name match" :
    "Single session — identity may be provisional";

  // Session duration
  let avgSessionDurationSec = null;
  const durations = sessions.filter((s: any) => s.started_at && s.ended_at).map((s: any) => (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000);
  if (durations.length > 0) avgSessionDurationSec = Math.round(durations.reduce((a: number, b: number) => a + b, 0) / durations.length);

  // Importance and tier stats
  const allScores = [...commitments, ...decisions, ...entities].map((a: any) => a.importance_score ?? 0).filter((s: number) => s > 0);
  const avgImportanceScore = allScores.length > 0 ? Math.round(allScores.reduce((a: number, b: number) => a + b, 0) / allScores.length * 100) / 100 : null;
  const statedCount = [...commitments, ...decisions, ...entities].filter((a: any) => a.source_tier === "STATED").length;
  const inferredCount = [...commitments, ...decisions, ...entities].filter((a: any) => a.source_tier === "INFERRED").length;
  const patternCount = [...commitments, ...decisions, ...entities].filter((a: any) => a.source_tier === "PATTERN").length;
  const tierTotal = statedCount + inferredCount + patternCount;

  const daysSinceLastSeen = persona.last_seen_at ? Math.floor((Date.now() - new Date(persona.last_seen_at).getTime()) / 86400000) : null;

  // Recent session count (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const recentSessionCount = sessions.filter((s: any) => s.started_at >= thirtyDaysAgo).length;

  return {
    commitmentReliability, claimAccuracy, consistency,
    intentDistribution, topIntents,
    avgHedgingScore, hedgingTrend, evasionTopicMap,
    recentSessionCount,
    recentVsHistoricalActivity,
    identityConfidence, identityNote,
    totalSessions, totalArtifacts,
    avgSessionDurationSec,
    firstSeenAt: persona.created_at, lastSeenAt: persona.last_seen_at, daysSinceLastSeen,
    avgImportanceScore, statedCount, inferredCount, patternCount,
    statedRatio: tierTotal > 0 ? Math.round(statedCount / tierTotal * 100) / 100 : null,
    hasEnoughForReliability: totalSessions >= 3 && commitments.filter((c: any) => c.due_date_text).length >= 3,
    hasEnoughForPatterns: totalSessions >= 5,
    hasEnoughForOutcomes: totalSessions >= 3 && totalArtifacts >= 10,
    hasEnoughForInfluence: totalSessions >= 4 && Object.keys(allIntents).length > 0,
  };
}

// ── JSON Migration ───────────────────────────────────────────────────

function migrateFromJSON(db: Database.Database, jsonPath: string): void {
  if (!existsSync(jsonPath)) {
    console.log("[db] No JSON file found, starting fresh");
    return;
  }

  const backupPath = join(dirname(jsonPath), "validateai_backup.json");
  if (existsSync(backupPath)) {
    console.log("[db] Backup already exists, skipping migration");
    return;
  }

  try {
    const raw = readFileSync(jsonPath, "utf-8");
    if (!raw || raw.trim().length < 2) return;
    const data = JSON.parse(raw);

    importJSON(db, data);

    renameSync(jsonPath, backupPath);
    console.log("[db] Migration complete, backup at:", backupPath);
  } catch (err: any) {
    console.error("[db] Migration failed:", err.message);
  }
}

// ── Import / Export ──────────────────────────────────────────────────

export function importJSON(db: Database.Database, data: any): void {
  const tx = db.transaction(() => {
    // Clear tables (FTS triggers handle search_index cleanup)
    db.exec("DELETE FROM commitments; DELETE FROM decisions; DELETE FROM entities; DELETE FROM contradictions; DELETE FROM pinned_items; DELETE FROM personas; DELETE FROM sessions; DELETE FROM app_state;");

    const statuses: Record<string, boolean> = data.commitmentStatuses ?? {};
    const now = new Date().toISOString();

    // Sessions
    const insSession = db.prepare("INSERT OR REPLACE INTO sessions(id, label, started_at, ended_at, status, stats_json) VALUES(?,?,?,?,?,?)");
    for (const s of data.sessions ?? []) {
      insSession.run(s.id, s.label, s.startedAt, s.endedAt ?? null, s.status, JSON.stringify(s.stats ?? {}));
    }

    // Build persona name → id map for artifact linking
    const personaMap = new Map<string, string>();
    for (const p of data.personas ?? []) {
      personaMap.set(p.name.toLowerCase(), p.id);
      for (const a of p.aliases ?? []) personaMap.set(a.toLowerCase(), p.id);
    }
    function findPersonaId(text: string, owner?: string): string | null {
      const combined = ((text || "") + " " + (owner || "")).toLowerCase();
      for (const [name, pid] of personaMap) {
        if (combined.includes(name)) return pid;
      }
      return null;
    }

    // Commitments
    const insCommit = db.prepare("INSERT OR REPLACE INTO commitments(id, session_id, persona_id, text, owner, due_date_text, status, source_tier, importance_score, confirmation_count, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    for (const c of data.commitments ?? []) {
      const pid = findPersonaId(c.text, c.owner);
      const done = statuses[c.text] === true ? "done" : "pending";
      insCommit.run("c_" + (c.ts || Date.now()) + "_" + Math.random().toString(36).slice(2, 6),
        c.sessionId ?? null, pid, c.text, c.owner ?? null, c.dueDate ?? null, done,
        c.sourceTier ?? "INFERRED", c.importanceScore ?? 5, c.confirmationCount ?? 1,
        c.ts ? new Date(c.ts).toISOString() : now);
    }

    // Decisions (handle legacy string[] format)
    const insDecision = db.prepare("INSERT OR REPLACE INTO decisions(id, session_id, persona_id, text, source_tier, importance_score, confirmation_count, created_at) VALUES(?,?,?,?,?,?,?,?)");
    for (const d of data.decisions ?? []) {
      const text = typeof d === "string" ? d : d.text;
      const ts = typeof d === "string" ? 0 : (d.ts ?? 0);
      const sid = typeof d === "string" ? null : (d.sessionId ?? null);
      const pid = findPersonaId(text);
      insDecision.run("d_" + (ts || Date.now()) + "_" + Math.random().toString(36).slice(2, 6),
        sid, pid, text, (typeof d !== "string" && d.sourceTier) || "INFERRED",
        (typeof d !== "string" && d.importanceScore) || 5,
        (typeof d !== "string" && d.confirmationCount) || 1,
        ts ? new Date(ts).toISOString() : now);
    }

    // Entities
    const insEntity = db.prepare("INSERT OR REPLACE INTO entities(id, session_id, persona_id, text, type, context, source_tier, importance_score, confirmation_count, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
    for (const e of data.entities ?? []) {
      const pid = findPersonaId(e.text, e.context);
      insEntity.run("e_" + (e.ts || Date.now()) + "_" + Math.random().toString(36).slice(2, 6),
        e.sessionId ?? null, pid, e.text, e.type, e.context ?? "",
        e.sourceTier ?? "INFERRED", e.importanceScore ?? 3, e.confirmationCount ?? 1,
        e.ts ? new Date(e.ts).toISOString() : now);
    }

    // Pinned items
    const insPinned = db.prepare("INSERT OR REPLACE INTO pinned_items(id, session_id, persona_id, text, source_text, created_at) VALUES(?,?,?,?,?,?)");
    for (const p of data.pinned ?? []) {
      const pid = findPersonaId(p.text);
      insPinned.run(p.id, p.sessionId ?? null, pid, p.text, p.source ?? "", p.ts ? new Date(p.ts).toISOString() : now);
    }

    // Personas (NO session_ids_json — derived from artifact tables)
    const insPersona = db.prepare("INSERT OR REPLACE INTO personas(id, name, aliases_json, notes, signal_snapshots_json, brief_json, is_self, created_at, last_seen_at) VALUES(?,?,?,?,?,?,?,?,?)");
    for (const p of data.personas ?? []) {
      insPersona.run(p.id, p.name, JSON.stringify(p.aliases ?? []),
        p.notes ?? "", JSON.stringify(p.signalSnapshots ?? []),
        p.brief ? JSON.stringify(p.brief) : null,
        p.isSelf ? 1 : 0,
        p.createdAt, p.lastSeenAt);
    }

    // Active session ID
    if (data.activeSessionId) {
      db.prepare("INSERT OR REPLACE INTO app_state(key, value) VALUES('activeSessionId', ?)").run(data.activeSessionId);
    }
  });

  tx();

  // Count migrated records
  const counts = {
    sessions: (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as any).n,
    commitments: (db.prepare("SELECT COUNT(*) as n FROM commitments").get() as any).n,
    decisions: (db.prepare("SELECT COUNT(*) as n FROM decisions").get() as any).n,
    entities: (db.prepare("SELECT COUNT(*) as n FROM entities").get() as any).n,
    personas: (db.prepare("SELECT COUNT(*) as n FROM personas").get() as any).n,
    pinned: (db.prepare("SELECT COUNT(*) as n FROM pinned_items").get() as any).n,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log("[db] Migration complete:", total, "records migrated", counts);
}

export function exportJSON(db: Database.Database): string {
  const sessions = db.prepare("SELECT * FROM sessions ORDER BY started_at DESC").all().map((s: any) => ({
    id: s.id, label: s.label, startedAt: s.started_at, endedAt: s.ended_at || undefined,
    status: s.status, stats: JSON.parse(s.stats_json || "{}"),
  }));

  const commitmentRows = db.prepare("SELECT * FROM commitments").all() as any[];
  const commitments = commitmentRows.map((c: any) => ({
    text: c.text, owner: c.owner || undefined, dueDate: c.due_date_text || undefined,
    ts: new Date(c.created_at).getTime(), sessionId: c.session_id || undefined,
    sourceTier: c.source_tier || "INFERRED", importanceScore: c.importance_score ?? 5, confirmationCount: c.confirmation_count ?? 1,
  }));
  const commitmentStatuses: Record<string, boolean> = {};
  for (const c of commitmentRows) {
    if (c.status === "done") commitmentStatuses[c.text] = true;
  }

  const decisions = db.prepare("SELECT * FROM decisions").all().map((d: any) => ({
    text: d.text, ts: new Date(d.created_at).getTime(), sessionId: d.session_id || undefined,
  }));

  const entities = db.prepare("SELECT * FROM entities").all().map((e: any) => ({
    text: e.text, type: e.type, context: e.context || "",
    ts: new Date(e.created_at).getTime(), sessionId: e.session_id || undefined,
    sourceTier: e.source_tier || "INFERRED", importanceScore: e.importance_score ?? 3, confirmationCount: e.confirmation_count ?? 1,
  }));

  const pinned = db.prepare("SELECT * FROM pinned_items").all().map((p: any) => ({
    id: p.id, text: p.text, source: p.source_text || "",
    ts: new Date(p.created_at).getTime(), sessionId: p.session_id || undefined,
  }));

  // Personas — derive sessionIds from artifact tables (single batch query, not N+1)
  const rawPersonas = db.prepare("SELECT * FROM personas").all() as any[];
  const allPersonaSessions = db.prepare(`
    SELECT DISTINCT persona_id, session_id FROM (
      SELECT persona_id, session_id FROM commitments WHERE persona_id IS NOT NULL AND session_id IS NOT NULL
      UNION SELECT persona_id, session_id FROM decisions WHERE persona_id IS NOT NULL AND session_id IS NOT NULL
      UNION SELECT persona_id, session_id FROM entities WHERE persona_id IS NOT NULL AND session_id IS NOT NULL
      UNION SELECT persona_id, session_id FROM pinned_items WHERE persona_id IS NOT NULL AND session_id IS NOT NULL
      UNION SELECT persona_id, session_id FROM contradictions WHERE persona_id IS NOT NULL AND session_id IS NOT NULL
    )
  `).all() as any[];
  const personaSessionMap = new Map<string, string[]>();
  for (const row of allPersonaSessions) {
    const arr = personaSessionMap.get(row.persona_id) || [];
    arr.push(row.session_id);
    personaSessionMap.set(row.persona_id, arr);
  }

  const personas = rawPersonas.map((p: any) => {
    const sids = personaSessionMap.get(p.id) || [];
    return {
      id: p.id, name: p.name, aliases: JSON.parse(p.aliases_json || "[]"),
      createdAt: p.created_at, lastSeenAt: p.last_seen_at,
      sessionIds: sids, notes: p.notes || "",
      isSelf: p.is_self === 1 ? true : undefined,
      brief: p.brief_json ? JSON.parse(p.brief_json) : undefined,
      signalSnapshots: JSON.parse(p.signal_snapshots_json || "[]"),
    };
  });

  const activeRow = db.prepare("SELECT value FROM app_state WHERE key = 'activeSessionId'").get() as any;

  return JSON.stringify({
    pinned, commitments, decisions, entities, sessions, personas,
    commitmentStatuses, activeSessionId: activeRow?.value ?? null,
  });
}

export function clearAll(db: Database.Database): void {
  db.exec("DELETE FROM commitments; DELETE FROM decisions; DELETE FROM entities; DELETE FROM contradictions; DELETE FROM pinned_items; DELETE FROM personas; DELETE FROM sessions; DELETE FROM app_state;");
}
