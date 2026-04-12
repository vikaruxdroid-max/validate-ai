import { claudeRequest } from "./claude";
import { RECALL_SYSTEM } from "../prompts/haiku";
import type { IMemoryStore, CommitmentEntry, EntityEntry, EntityType } from "../models/types";

const PROXY_BASE = "https://vikarux-g2.centralus.cloudapp.azure.com:3001";

interface PinnedItem {
  id: string;
  text: string;
  source: string;
  ts: number;
}

export class MemoryStore implements IMemoryStore {
  private pinned: PinnedItem[] = [];
  private commitments: CommitmentEntry[] = [];
  private decisions: string[] = [];
  private entities: EntityEntry[] = [];
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;

  pin(item: { text: string; source: string }): void {
    this.pinned.push({
      id: crypto.randomUUID(),
      text: item.text,
      source: item.source,
      ts: Date.now(),
    });
    console.log("[MemoryStore] pinned:", item.text);
  }

  async recall(
    query: string,
  ): Promise<{ found: boolean; matches?: string[]; context?: string }> {
    const items = this.getAllItems();
    if (items.length === 0) {
      return { found: false };
    }

    const itemList = items
      .map((item, i) => `${i + 1}. ${item}`)
      .join("\n");

    const userMsg = `Query: ${query}\n\nStored items:\n${itemList}`;

    try {
      const raw = await claudeRequest(
        "claude-haiku-4-5-20251001",
        RECALL_SYSTEM,
        userMsg,
        undefined,
        256,
      );

      console.log("[MemoryStore] recall raw:", raw);

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { found: false };

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        found: !!parsed.found,
        matches: parsed.matches,
        context: parsed.context,
      };
    } catch (err) {
      console.warn("[MemoryStore] recall error:", err);
      return { found: false };
    }
  }

  getSession() {
    return {
      pinned: [...this.pinned],
      commitments: [...this.commitments],
      decisions: [...this.decisions],
      entities: [...this.entities],
    };
  }

  getCommitments(): CommitmentEntry[] {
    return [...this.commitments];
  }

  getDecisions(): string[] {
    return [...this.decisions];
  }

  getEntities(): EntityEntry[] {
    return [...this.entities];
  }

  clearSession(): void {
    this.pinned = [];
    this.commitments = [];
    this.decisions = [];
    this.entities = [];
    console.log("[MemoryStore] session cleared");
  }

  addCommitment(entry: { text: string; owner?: string; dueDate?: string }): void {
    if (this.commitments.some((c) => c.text === entry.text)) return;
    this.commitments.push({
      text: entry.text,
      owner: entry.owner,
      dueDate: entry.dueDate,
      ts: Date.now(),
    });
    console.log("[MemoryStore] commitment:", entry.text);
  }

  addDecision(text: string): void {
    if (!this.decisions.includes(text)) {
      this.decisions.push(text);
      console.log("[MemoryStore] decision:", text);
    }
  }

  addEntity(entry: { text: string; type: EntityType; context: string }): void {
    if (this.entities.some((e) => e.text === entry.text)) return;
    this.entities.push({
      text: entry.text,
      type: entry.type,
      context: entry.context,
      ts: Date.now(),
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
    });
  }

  loadJSON(json: string): void {
    try {
      const data = JSON.parse(json);
      this.pinned = data.pinned ?? [];
      this.commitments = data.commitments ?? [];
      this.decisions = data.decisions ?? [];
      this.entities = data.entities ?? [];
      console.log("[MemoryStore] loaded from JSON — pinned:", this.pinned.length,
        "commitments:", this.commitments.length,
        "decisions:", this.decisions.length,
        "entities:", this.entities.length);
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
      console.warn("[MemoryStore] load error (may not exist yet):", err);
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
    console.log("[MemoryStore] auto-save started, interval:", intervalMs);
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
      ...this.decisions.map((d) => `[decision] ${d}`),
      ...this.entities.map((e) => `[${e.type.toLowerCase()}] ${e.text} — ${e.context}`),
    ];
  }
}
