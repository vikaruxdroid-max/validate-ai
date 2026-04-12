import { BaseAnalyzer } from "./base";
import { claudeRequest } from "../services/claude";
import { COMMITMENTS_SYSTEM } from "../prompts/haiku";
import type { AnalyzerContext, AnalyzerResult, Confidence } from "../models/types";

const MIN_NEW_CHARS = 20;

export class CommitmentsAnalyzer extends BaseAnalyzer {
  readonly name = "commitments";
  readonly category = "conversation";
  readonly priority = 60;
  readonly schedule = "passive" as const;
  readonly intervalMs = 3000;
  readonly defaultCooldownMs = 15_000;

  private lastAnalyzedLength = 0;

  async analyze(ctx: AnalyzerContext): Promise<AnalyzerResult> {
    // Skip if not enough new transcript content
    if (ctx.rollingText.length - this.lastAnalyzedLength < MIN_NEW_CHARS) {
      return this.noTrigger();
    }

    // Use last 60 seconds of transcript
    const cutoff = Date.now() - 60_000;
    const recent = ctx.transcriptWindow
      .filter((s) => s.ts >= cutoff)
      .map((s) => s.text)
      .join(" ");

    if (recent.trim().length < 15) return this.noTrigger();

    this.lastAnalyzedLength = ctx.rollingText.length;

    const raw = await claudeRequest(
      "claude-haiku-4-5-20251001",
      COMMITMENTS_SYSTEM,
      recent,
      undefined,
      128,
    );

    console.log("[Commitments] raw:", raw);

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return this.noTrigger();

    try {
      const parsed = JSON.parse(match[0]);
      if (!parsed.found) return this.noTrigger();

      const confidence = (parsed.confidence ?? "LOW") as Confidence;
      if (confidence === "LOW") return this.noTrigger();

      // Auto-store in memory
      if (ctx.memoryStore && parsed.commitment) {
        ctx.memoryStore.addCommitment(parsed.commitment);
      }

      const owner = parsed.owner ? ` (${parsed.owner})` : "";
      const due = parsed.dueDate ? ` by ${parsed.dueDate}` : "";

      return this.result({
        confidence,
        title: "COMMITMENT",
        summary: `${parsed.commitment}${owner}${due}`,
        suggestedHudMode: "PASSIVE",
        expiresInMs: 4000,
        details: { commitment: parsed.commitment, owner: parsed.owner, dueDate: parsed.dueDate },
      });
    } catch {
      return this.noTrigger();
    }
  }
}
