import { claudeRequest } from "./claude";
import { RECALL_SYSTEM } from "../prompts/haiku";
import type { IMemoryStore, CommitmentEntry, DecisionEntry, EntityEntry, EntityType, PinnedItem, SessionEntry, Persona, PersonaBrief, PersonaSignalSnapshot, SourceTier } from "../models/types";
import { matchesPersona } from "../utils/personaUtils";
import { CLAUDE_HAIKU } from "../utils/models";

const PROXY_BASE = "https://vikarux-g2.centralus.cloudapp.azure.com:3001";

export class MemoryStore implements IMemoryStore {
  private pinned: PinnedItem[] = [];
  private commitments: CommitmentEntry[] = [];
  private decisions: DecisionEntry[] = [];
  private entities: EntityEntry[] = [];
  private sessions: SessionEntry[] = [];
  private personas: Persona[] = [];
  private commitmentStatuses: Record<string, boolean> = {};
  private activeSessionId: string | null = null;
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;

  // ── Sessions ──────────────────────────────────────────────────────

  startSession(): string {
    // End any active session first
    if (this.activeSessionId) this.endSession(0, 0);

    const now = new Date();
    const id = "session_" + now.toISOString();
    const label = now.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " \u00b7 " + now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

    const session: SessionEntry = {
      id,
      label,
      startedAt: now.toISOString(),
      status: "active",
      stats: { factsChecked: 0, commitmentsStored: 0, decisionsStored: 0, entitiesTracked: 0, contradictionsDetected: 0 },
    };

    this.sessions.push(session);
    this.activeSessionId = id;

    return id;
  }

  endSession(factsChecked: number, contradictions: number): void {
    if (!this.activeSessionId) return;
    const s = this.sessions.find((x) => x.id === this.activeSessionId);
    if (s) {
      s.status = "completed";
      s.endedAt = new Date().toISOString();
      // Recount artifacts for this session
      s.stats.commitmentsStored = this.commitments.filter((c) => c.sessionId === s.id).length;
      s.stats.decisionsStored = this.decisions.filter((d) => d.sessionId === s.id).length;
      s.stats.entitiesTracked = this.entities.filter((e) => e.sessionId === s.id).length;
      s.stats.factsChecked = factsChecked;
      s.stats.contradictionsDetected = contradictions;
    }
    this.activeSessionId = null;
  }

  getCurrentSessionId(): string | null {
    return this.activeSessionId;
  }

  getSessions(): SessionEntry[] {
    return [...this.sessions].reverse();
  }

  // ── Pin ────────────────────────────────────────────────────────────

  pin(item: { text: string; source: string }, sessionId?: string): void {
    this.pinned.push({
      id: crypto.randomUUID(),
      text: item.text,
      source: item.source,
      ts: Date.now(),
      sessionId: sessionId ?? this.activeSessionId ?? undefined,
    });
  }

  // ── Recall ────────────────────────────────────────────────────────

  async recall(
    query: string,
  ): Promise<{ found: boolean; matches?: string[]; context?: string }> {
    const items = this.getAllItems();
    if (items.length === 0) return { found: false };

    const itemList = items.map((item, i) => `${i + 1}. ${item}`).join("\n");
    const userMsg = `Query: ${query}\n\nStored items:\n${itemList}`;

    try {
      const raw = await claudeRequest(CLAUDE_HAIKU, RECALL_SYSTEM, userMsg, undefined, 256);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { found: false };
      const parsed = JSON.parse(jsonMatch[0]);
      return { found: !!parsed.found, matches: parsed.matches, context: parsed.context };
    } catch (err) {
      console.warn("[MemoryStore] recall error:", err);
      return { found: false };
    }
  }

  // ── Getters ───────────────────────────────────────────────────────

  getSession() {
    return {
      pinned: [...this.pinned],
      commitments: [...this.commitments],
      decisions: this.decisions.map((d) => d.text),
      entities: [...this.entities],
    };
  }

  getCommitments(): CommitmentEntry[] { return [...this.commitments]; }
  getDecisions(): string[] { return this.decisions.map((d) => d.text); }
  getEntities(): EntityEntry[] { return [...this.entities]; }

  /** Get raw decisions with metadata (for session grouping). */
  getDecisionsRaw() { return [...this.decisions]; }

  // ── Personas ──────────────────────────────────────────────────────

  createPersona(name: string, sessionId?: string): Persona {
    const now = new Date().toISOString();
    const persona: Persona = {
      id: "persona_" + crypto.randomUUID(),
      name,
      aliases: [],
      createdAt: now,
      lastSeenAt: now,
      sessionIds: sessionId ? [sessionId] : [],
      notes: "",
    };
    this.personas.push(persona);
    return persona;
  }

  getPersonas(): Persona[] {
    return [...this.personas];
  }

  getPersonaById(id: string): Persona | undefined {
    return this.personas.find((p) => p.id === id);
  }

  updatePersona(id: string, updates: Partial<Pick<Persona, "name" | "aliases" | "notes">>): void {
    const p = this.personas.find((x) => x.id === id);
    if (!p) return;
    if (updates.name !== undefined) p.name = updates.name;
    if (updates.aliases !== undefined) p.aliases = updates.aliases;
    if (updates.notes !== undefined) p.notes = updates.notes;
  }

  linkArtifactToPersona(personaId: string, sessionId: string): void {
    const p = this.personas.find((x) => x.id === personaId);
    if (!p) return;
    if (!p.sessionIds.includes(sessionId)) {
      p.sessionIds.push(sessionId);
    }
    p.lastSeenAt = new Date().toISOString();
  }

  /** Check a new artifact against all personas and link its session if name matches. */
  checkPersonaLinkForArtifact(text: string, sessionId?: string): void {
    if (!sessionId) return;
    for (const p of this.personas) {
      if (matchesPersona(text, p)) {
        if (!p.sessionIds.includes(sessionId)) {
          p.sessionIds.push(sessionId);
        }
        p.lastSeenAt = new Date().toISOString();
      }
    }
  }

  /** Retroactively scan all artifacts and link sessions to a newly created persona. */
  retroactiveLinkPersona(personaId: string): void {
    const p = this.personas.find(x => x.id === personaId);
    if (!p) return;
    const sessionSet = new Set(p.sessionIds);

    for (const c of this.commitments) {
      if (c.sessionId && matchesPersona((c.text || "") + " " + (c.owner || ""), p)) sessionSet.add(c.sessionId);
    }
    for (const d of this.decisions) {
      if (d.sessionId && matchesPersona(d.text, p)) sessionSet.add(d.sessionId);
    }
    for (const e of this.entities) {
      if (e.sessionId && matchesPersona((e.text || "") + " " + (e.context || ""), p)) sessionSet.add(e.sessionId);
    }
    for (const pin of this.pinned) {
      if (pin.sessionId && matchesPersona(pin.text, p)) sessionSet.add(pin.sessionId);
    }

    p.sessionIds = Array.from(sessionSet);
  }

  markPersonaAsSelf(id: string): void {
    for (const p of this.personas) p.isSelf = p.id === id;
  }

  getSelfPersona(): Persona | undefined {
    return this.personas.find(p => p.isSelf === true);
  }

  setPersonaBrief(personaId: string, brief: PersonaBrief): void {
    const p = this.personas.find((x) => x.id === personaId);
    if (p) p.brief = brief;
  }

  addPersonaSignalSnapshot(personaId: string, snapshot: PersonaSignalSnapshot): void {
    const p = this.personas.find((x) => x.id === personaId);
    if (!p) return;
    if (!p.signalSnapshots) p.signalSnapshots = [];
    // Avoid duplicate session snapshots
    if (!p.signalSnapshots.some((s) => s.sessionId === snapshot.sessionId)) {
      p.signalSnapshots.push(snapshot);
    }
  }

  setCommitmentStatus(commitmentText: string, done: boolean): void {
    this.commitmentStatuses[commitmentText] = done;
  }

  getCommitmentStatuses(): Record<string, boolean> {
    return { ...this.commitmentStatuses };
  }

  clearSession(): void {
    this.pinned = [];
    this.commitments = [];
    this.decisions = [];
    this.entities = [];
    this.sessions = [];
    this.personas = [];
    this.commitmentStatuses = {};
    this.activeSessionId = null;
  }

  // ── Add methods ───────────────────────────────────────────────────

  addCommitment(entry: { text: string; owner?: string; dueDate?: string }, sessionId?: string): void {
    const sid = sessionId ?? this.activeSessionId ?? undefined;
    // Near-duplicate detection: same owner + similar first 30 chars
    const prefix = entry.text.slice(0, 30).toLowerCase();
    const dup = this.commitments.find(c =>
      c.text.slice(0, 30).toLowerCase() === prefix &&
      (c.owner || "").toLowerCase() === (entry.owner || "").toLowerCase());
    if (dup) {
      dup.confirmationCount = Math.min((dup.confirmationCount ?? 1) + 1, 99);
      dup.importanceScore = Math.min((dup.importanceScore ?? 5) + 1, 10);
      return;
    }
    // Compute scoring
    const hasOwner = !!entry.owner;
    const hasDue = !!entry.dueDate;
    let score = (hasOwner ? 3 : 0) + (hasDue ? 2 : 0) + 2 + (entry.text.length > 50 ? 1 : 0);
    score = Math.max(1, Math.min(10, score));
    const tier: SourceTier = (hasOwner && hasDue) ? "STATED" : hasOwner ? "STATED" : "INFERRED";
    this.commitments.push({
      text: entry.text, owner: entry.owner, dueDate: entry.dueDate,
      ts: Date.now(), sessionId: sid,
      sourceTier: tier, importanceScore: score, confirmationCount: 1,
    });
    // Self-attribution: tag commitment with [SELF] marker if it matches the self persona
    const selfP = this.getSelfPersona();
    if (selfP && matchesPersona((entry.text || "") + " " + (entry.owner || ""), selfP)) {
      const c = this.commitments[this.commitments.length - 1];
      if (c && !(c.sourceText || "").includes("[SELF]")) {
        c.sourceText = (c.sourceText || "") + " [SELF]";
      }
    }
    this.checkPersonaLinkForArtifact((entry.text || "") + " " + (entry.owner || ""), sid);
  }

  addDecision(text: string, sessionId?: string): void {
    const sid = sessionId ?? this.activeSessionId ?? undefined;
    const prefix = text.slice(0, 40).toLowerCase();
    const dup = this.decisions.find(d => d.text.slice(0, 40).toLowerCase() === prefix);
    if (dup) {
      dup.confirmationCount = Math.min((dup.confirmationCount ?? 1) + 1, 99);
      dup.importanceScore = Math.min((dup.importanceScore ?? 5) + 1, 10);
      return;
    }
    let score = 3 + (text.length > 50 ? 2 : 0);
    score = Math.max(1, Math.min(10, score));
    this.decisions.push({ text, ts: Date.now(), sessionId: sid, sourceTier: "INFERRED", importanceScore: score, confirmationCount: 1 });
    this.checkPersonaLinkForArtifact(text, sid);
  }

  addEntity(entry: { text: string; type: EntityType; context: string }, sessionId?: string): void {
    const sid = sessionId ?? this.activeSessionId ?? undefined;
    const dup = this.entities.find(e => e.text === entry.text && e.type === entry.type);
    if (dup) {
      dup.confirmationCount = Math.min((dup.confirmationCount ?? 1) + 1, 99);
      dup.importanceScore = Math.min((dup.importanceScore ?? 3) + 1, 10);
      return;
    }
    const typeScores: Record<string, number> = { PERSON: 4, ORGANIZATION: 3, DATE: 2, NUMBER: 2, PLACE: 1 };
    let score = (typeScores[entry.type] ?? 1) + ((entry.context || "").length > 20 ? 2 : 0);
    score = Math.max(1, Math.min(10, score));
    const tier: SourceTier = entry.type === "PERSON" && (entry.context || "").length > 0 ? "STATED" : "INFERRED";
    this.entities.push({
      text: entry.text, type: entry.type, context: entry.context,
      ts: Date.now(), sessionId: sid,
      sourceTier: tier, importanceScore: score, confirmationCount: 1,
    });
    this.checkPersonaLinkForArtifact((entry.text || "") + " " + (entry.context || ""), sid);
  }

  // ── Persistence ───────────────────────────────────────────────────

  toJSON(): string {
    return JSON.stringify({
      pinned: this.pinned,
      commitments: this.commitments,
      decisions: this.decisions,
      entities: this.entities,
      sessions: this.sessions,
      personas: this.personas,
      commitmentStatuses: this.commitmentStatuses,
      activeSessionId: this.activeSessionId,
    });
  }

  loadJSON(json: string): void {
    try {
      const data = JSON.parse(json);
      this.pinned = data.pinned ?? [];
      this.commitments = data.commitments ?? [];
      // Handle old format where decisions were string[]
      if (data.decisions?.length > 0 && typeof data.decisions[0] === "string") {
        this.decisions = data.decisions.map((d: string) => ({ text: d, ts: 0 }));
      } else {
        this.decisions = data.decisions ?? [];
      }
      this.entities = data.entities ?? [];
      this.sessions = data.sessions ?? [];
      this.personas = data.personas ?? [];
      this.commitmentStatuses = data.commitmentStatuses ?? {};
      this.activeSessionId = data.activeSessionId ?? null;
    } catch (err) {
      console.warn("[MemoryStore] loadJSON failed:", err);
    }
  }

  async save(): Promise<void> {
    try {
      const res = await fetch(`${PROXY_BASE}/memory/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: this.toJSON(),
      });
      if (!res.ok) console.warn("[MemoryStore] save failed:", res.status);
    } catch (err) {
      console.warn("[MemoryStore] save error:", err);
    }
  }

  async load(): Promise<void> {
    try {
      const res = await fetch(`${PROXY_BASE}/memory/load`);
      if (res.ok) {
        const json = await res.text();
        if (json && json.trim().length > 2) this.loadJSON(json);
      }
    } catch (err) {
      console.warn("[MemoryStore] load error:", err);
    }
  }

  async deleteFile(): Promise<void> {
    try {
      await fetch(`${PROXY_BASE}/memory`, { method: "DELETE" });
    } catch (err) {
      console.warn("[MemoryStore] delete error:", err);
    }
  }

  startAutoSave(intervalMs = 60_000): void {
    this.stopAutoSave();
    this.autoSaveTimer = setInterval(() => this.save(), intervalMs);
  }

  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  private getAllItems(): string[] {
    return [
      ...this.pinned.map((p) => `[pinned] ${p.text}`),
      ...this.commitments.map((c) => {
        const parts = [c.text];
        if (c.owner) parts.push(`(${c.owner})`);
        if (c.dueDate) parts.push(`by ${c.dueDate}`);
        return `[commitment] ${parts.join(" ")}`;
      }),
      ...this.decisions.map((d) => `[decision] ${d.text}`),
      ...this.entities.map((e) => `[${e.type.toLowerCase()}] ${e.text} — ${e.context}`),
    ];
  }
}
