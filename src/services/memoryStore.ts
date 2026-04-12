import { claudeRequest } from "./claude";
import { RECALL_SYSTEM } from "../prompts/haiku";
import type { IMemoryStore, CommitmentEntry } from "../models/types";

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
  private entities = new Set<string>();

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

  clearSession(): void {
    this.pinned = [];
    this.commitments = [];
    this.decisions = [];
    this.entities.clear();
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
    console.log("[MemoryStore] commitment:", entry.text, "owner:", entry.owner, "due:", entry.dueDate);
  }

  addDecision(text: string): void {
    if (!this.decisions.includes(text)) {
      this.decisions.push(text);
      console.log("[MemoryStore] decision:", text);
    }
  }

  addEntity(name: string): void {
    if (!this.entities.has(name)) {
      this.entities.add(name);
      console.log("[MemoryStore] entity:", name);
    }
  }

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
      ...[...this.entities].map((e) => `[entity] ${e}`),
    ];
  }
}
