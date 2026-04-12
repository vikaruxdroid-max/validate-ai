import { BaseAnalyzer } from "./base";
import { claudeRequest } from "../services/claude";
import { HEDGING_SYSTEM } from "../prompts/haiku";
import type { AnalyzerContext, AnalyzerResult, Confidence } from "../models/types";

const MIN_NEW_CHARS = 20;
const HEDGING_THRESHOLD = 7;

export class HedgingAnalyzer extends BaseAnalyzer {
  readonly name = "hedging";
  readonly category = "conversation";
  readonly priority = 45;
  readonly schedule = "passive" as const;
  readonly intervalMs = 3000;
  readonly defaultCooldownMs = 15_000;

  private lastAnalyzedLength = 0;

  async analyze(ctx: AnalyzerContext): Promise<AnalyzerResult> {
    if (ctx.rollingText.length - this.lastAnalyzedLength < MIN_NEW_CHARS) {
      return this.noTrigger();
    }

    // Use last 30 seconds for hedging analysis
    const cutoff = Date.now() - 30_000;
    const recent = ctx.transcriptWindow
      .filter((s) => s.ts >= cutoff)
      .map((s) => s.text)
      .join(" ");

    if (recent.trim().length < 15) return this.noTrigger();

    this.lastAnalyzedLength = ctx.rollingText.length;

    const raw = await claudeRequest(
      "claude-haiku-4-5-20251001",
      HEDGING_SYSTEM,
      recent,
      undefined,
      128,
    );

    console.log("[Hedging] raw:", raw);

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return this.noTrigger();

    try {
      const parsed = JSON.parse(match[0]);
      const score: number = parsed.score ?? 0;
      const confidence = (parsed.confidence ?? "LOW") as Confidence;

      if (score < HEDGING_THRESHOLD) return this.noTrigger();

      const signals: string[] = parsed.signals ?? [];
      const signalText = signals.length > 0 ? signals.slice(0, 3).join(", ") : "high hedging";

      return this.result({
        confidence,
        title: "HIGH HEDGING",
        summary: `Score ${score}/10: ${signalText}`,
        suggestedHudMode: "PASSIVE",
        expiresInMs: 4000,
        details: { score, signals },
      });
    } catch {
      return this.noTrigger();
    }
  }
}
