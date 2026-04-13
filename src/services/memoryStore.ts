import { claudeRequest } from "./claude";
import { RECALL_SYSTEM } from "../prompts/haiku";
import type { IMemoryStore, CommitmentEntry, EntityEntry, EntityType, PinnedItem, SessionEntry, Persona } from "../models/types";

const PROXY_BASE = "https://vikarux-g2.centralus.cloudapp.azure.com:3001";

export class MemoryStore implements IMemoryStore {
  private pinned: PinnedItem[] = [];
  private commitments: CommitmentEntry[] = [];
  private decisions: { text: string; ts: number; sessionId?: string }[] = [];
  private entities: EntityEntry[] = [];
  private sessions: SessionEntry[] = [];
  private personas: Persona[] = [];
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
    console.log("[MemoryStore] session started:", id, label);
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
      console.log("[MemoryStore] session ended:", s.id);
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
    console.log("[MemoryStore] pinned:", item.text);
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
      const raw = await claudeRequest("claude-haiku-4-5-20251001", RECALL_SYSTEM, userMsg, undefined, 256);
      console.log("[MemoryStore] recall raw:", raw);
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
    console.log("[MemoryStore] persona created:", persona.name);
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
    console.log("[MemoryStore] persona updated:", p.name);
  }

  linkArtifactToPersona(personaId: string, sessionId: string): void {
    const p = this.personas.find((x) => x.id === personaId);
    if (!p) return;
    if (!p.sessionIds.includes(sessionId)) {
      p.sessionIds.push(sessionId);
    }
    p.lastSeenAt = new Date().toISOString();
    console.log("[MemoryStore] linked session to persona:", p.name, sessionId);
  }

  clearSession(): void {
    this.pinned = [];
    this.commitments = [];
    this.decisions = [];
    this.entities = [];
    this.sessions = [];
    this.personas = [];
    this.activeSessionId = null;
    console.log("[MemoryStore] session cleared");
  }

  // ── Add methods ───────────────────────────────────────────────────

  addCommitment(entry: { text: string; owner?: string; dueDate?: string }, sessionId?: string): void {
    if (this.commitments.some((c) => c.text === entry.text)) return;
    this.commitments.push({
      text: entry.text,
      owner: entry.owner,
      dueDate: entry.dueDate,
      ts: Date.now(),
      sessionId: sessionId ?? this.activeSessionId ?? undefined,
    });
    console.log("[MemoryStore] commitment:", entry.text);
  }

  addDecision(text: string, sessionId?: string): void {
    if (this.decisions.some((d) => d.text === text)) return;
    this.decisions.push({
      text,
      ts: Date.now(),
      sessionId: sessionId ?? this.activeSessionId ?? undefined,
    });
    console.log("[MemoryStore] decision:", text);
  }

  addEntity(entry: { text: string; type: EntityType; context: string }, sessionId?: string): void {
    if (this.entities.some((e) => e.text === entry.text)) return;
    this.entities.push({
      text: entry.text,
      type: entry.type,
      context: entry.context,
      ts: Date.now(),
      sessionId: sessionId ?? this.activeSessionId ?? undefined,
    });
    console.log("[MemoryStore] entity:", entry.type, entry.text);
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
      this.activeSessionId = data.activeSessionId ?? null;
      console.log("[MemoryStore] loaded — sessions:", this.sessions.length,
        "commitments:", this.commitments.length);
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
      else console.log("[MemoryStore] saved to proxy");
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
      console.log("[MemoryStore] file deleted on proxy");
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
