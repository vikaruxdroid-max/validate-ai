import { BaseAnalyzer } from "./base";
import { claudeRequest } from "../services/claude";
import { DECISIONS_SYSTEM } from "../prompts/haiku";
import type { AnalyzerContext, AnalyzerResult, Confidence } from "../models/types";

const MIN_NEW_CHARS = 20;

export class DecisionsAnalyzer extends BaseAnalyzer {
  readonly name = "decisions";
  readonly category = "conversation";
  readonly priority = 55;
  readonly schedule = "passive" as const;
  readonly intervalMs = 3000;
  readonly defaultCooldownMs = 15_000;

  private lastAnalyzedLength = 0;

  async analyze(ctx: AnalyzerContext): Promise<AnalyzerResult> {
    if (ctx.rollingText.length - this.lastAnalyzedLength < MIN_NEW_CHARS) {
      return this.noTrigger();
    }

    const cutoff = Date.now() - 60_000;
    const recent = ctx.transcriptWindow
      .filter((s) => s.ts >= cutoff)
      .map((s) => s.text)
      .join(" ");

    if (recent.trim().length < 15) return this.noTrigger();

    this.lastAnalyzedLength = ctx.rollingText.length;

    const raw = await claudeRequest(
      "claude-haiku-4-5-20251001",
      DECISIONS_SYSTEM,
      recent,
      undefined,
      128,
    );

    console.log("[Decisions] raw:", raw);

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return this.noTrigger();

    try {
      const parsed = JSON.parse(match[0]);
      if (!parsed.found) return this.noTrigger();

      const confidence = (parsed.confidence ?? "LOW") as Confidence;
      // Only surface HIGH confidence decisions
      if (confidence !== "HIGH") return this.noTrigger();

      if (ctx.memoryStore && parsed.decision) {
        ctx.memoryStore.addDecision(parsed.decision);
      }

      return this.result({
        confidence,
        title: "DECISION",
        summary: parsed.decision ?? "Decision detected",
        suggestedHudMode: "PASSIVE",
        expiresInMs: 4000,
        details: { decision: parsed.decision },
      });
    } catch {
      return this.noTrigger();
    }
  }
}
