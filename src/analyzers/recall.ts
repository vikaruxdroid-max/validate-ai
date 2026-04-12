import { BaseAnalyzer } from "./base";
import type { AnalyzerContext, AnalyzerResult } from "../models/types";

const RECALL_TRIGGERS = [
  "even recall",
  "even rico",
  "even recal",
  "even rekal",
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/ +/g, " ")
    .trim();
}

export class RecallAnalyzer extends BaseAnalyzer {
  readonly name = "recall";
  readonly category = "memory";
  readonly priority = 80;
  readonly schedule = "active" as const;
  readonly intervalMs = 0;
  readonly defaultCooldownMs = 10_000;

  /** Check if text contains a recall trigger. */
  checkTrigger(latestText: string): string | null {
    const clean = normalize(latestText);
    for (const t of RECALL_TRIGGERS) {
      if (clean.includes(t)) return t;
    }
    return null;
  }

  async analyze(ctx: AnalyzerContext): Promise<AnalyzerResult> {
    if (!ctx.memoryStore) {
      return this.result({
        confidence: "LOW",
        title: "RECALL",
        summary: "Memory store not available",
        suggestedHudMode: "COMPACT",
        expiresInMs: 4000,
      });
    }

    const session = ctx.memoryStore.getSession();
    const totalItems =
      session.pinned.length +
      session.commitments.length +
      session.decisions.length +
      session.entities.length;

    if (totalItems === 0) {
      return this.result({
        confidence: "LOW",
        title: "RECALL",
        summary: "Nothing stored yet",
        suggestedHudMode: "COMPACT",
        expiresInMs: 4000,
      });
    }

    // Use recent transcript (last 15s, excluding the trigger itself) as the query
    const now = Date.now();
    const cutoff = now - 15_000;
    const querySegments = ctx.transcriptWindow
      .filter((s) => s.ts >= cutoff)
      .map((s) => s.text)
      .join(" ");

    const query = querySegments.trim() || "most recent items";

    console.log("[Recall] query:", query, "items:", totalItems);

    const result = await ctx.memoryStore.recall(query);

    if (!result.found || !result.match) {
      return this.result({
        confidence: "LOW",
        title: "RECALL",
        summary: "No matching memory found",
        suggestedHudMode: "COMPACT",
        expiresInMs: 4000,
      });
    }

    console.log("[Recall] found:", result.match);

    return this.result({
      confidence: "MED",
      title: "RECALL",
      summary: result.match,
      suggestedHudMode: "CARD",
      expiresInMs: 8000,
      details: { match: result.match, context: result.context },
    });
  }
}
