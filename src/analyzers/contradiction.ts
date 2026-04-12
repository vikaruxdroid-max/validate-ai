import { BaseAnalyzer } from "./base";
import { claudeRequest } from "../services/claude";
import { CONTRADICTION_SYSTEM } from "../prompts/haiku";
import type { AnalyzerContext, AnalyzerResult, Confidence } from "../models/types";

const MIN_NEW_CHARS = 20;

export class ContradictionAnalyzer extends BaseAnalyzer {
  readonly name = "contradiction";
  readonly category = "analysis";
  readonly priority = 70;
  readonly schedule = "passive" as const;
  readonly intervalMs = 5000;
  readonly defaultCooldownMs = 20_000;

  private lastAnalyzedLength = 0;

  async analyze(ctx: AnalyzerContext): Promise<AnalyzerResult> {
    if (ctx.rollingText.length - this.lastAnalyzedLength < MIN_NEW_CHARS) {
      return this.noTrigger();
    }

    const now = Date.now();

    // RECENT: last 15 seconds
    const recentCutoff = now - 15_000;
    const recentText = ctx.transcriptWindow
      .filter((s) => s.ts >= recentCutoff)
      .map((s) => s.text)
      .join(" ");

    // PRIOR: everything before that (up to 90s buffer)
    const priorText = ctx.transcriptWindow
      .filter((s) => s.ts < recentCutoff)
      .map((s) => s.text)
      .join(" ");

    if (recentText.trim().length < 10 || priorText.trim().length < 20) {
      return this.noTrigger();
    }

    this.lastAnalyzedLength = ctx.rollingText.length;

    const userMsg = `RECENT:\n${recentText}\n\nPRIOR:\n${priorText}`;

    const raw = await claudeRequest(
      "claude-haiku-4-5-20251001",
      CONTRADICTION_SYSTEM,
      userMsg,
      undefined,
      128,
    );

    console.log("[Contradiction] raw:", raw);

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return this.noTrigger();

    try {
      const parsed = JSON.parse(match[0]);
      if (!parsed.found) return this.noTrigger();

      const confidence = (parsed.confidence ?? "LOW") as Confidence;
      // Only surface HIGH confidence contradictions
      if (confidence !== "HIGH") return this.noTrigger();

      return this.result({
        confidence,
        title: "CONTRADICTION",
        summary: parsed.current ?? "Contradiction detected",
        suggestedHudMode: "ALERT",
        expiresInMs: 8000,
        details: { current: parsed.current, prior: parsed.prior },
      });
    } catch {
      return this.noTrigger();
    }
  }
}
