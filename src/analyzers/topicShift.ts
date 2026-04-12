import { BaseAnalyzer } from "./base";
import { claudeRequest } from "../services/claude";
import { TOPIC_SHIFT_SYSTEM } from "../prompts/haiku";
import type { AnalyzerContext, AnalyzerResult, Confidence } from "../models/types";

const MIN_NEW_CHARS = 20;

export class TopicShiftAnalyzer extends BaseAnalyzer {
  readonly name = "topicShift";
  readonly category = "conversation";
  readonly priority = 30;
  readonly schedule = "passive" as const;
  readonly intervalMs = 3000;
  readonly defaultCooldownMs = 10_000;

  private lastAnalyzedLength = 0;

  async analyze(ctx: AnalyzerContext): Promise<AnalyzerResult> {
    if (ctx.rollingText.length - this.lastAnalyzedLength < MIN_NEW_CHARS) {
      return this.noTrigger();
    }

    const now = Date.now();

    // RECENT: last 10 seconds
    const recentCutoff = now - 10_000;
    const recentText = ctx.transcriptWindow
      .filter((s) => s.ts >= recentCutoff)
      .map((s) => s.text)
      .join(" ");

    // PRIOR: 10-40 seconds ago
    const priorStart = now - 40_000;
    const priorText = ctx.transcriptWindow
      .filter((s) => s.ts >= priorStart && s.ts < recentCutoff)
      .map((s) => s.text)
      .join(" ");

    if (recentText.trim().length < 10 || priorText.trim().length < 10) {
      return this.noTrigger();
    }

    this.lastAnalyzedLength = ctx.rollingText.length;

    const userMsg = `RECENT:\n${recentText}\n\nPRIOR:\n${priorText}`;

    const raw = await claudeRequest(
      "claude-haiku-4-5-20251001",
      TOPIC_SHIFT_SYSTEM,
      userMsg,
      undefined,
      96,
    );

    console.log("[TopicShift] raw:", raw);

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return this.noTrigger();

    try {
      const parsed = JSON.parse(match[0]);
      if (!parsed.shifted) return this.noTrigger();

      const confidence = (parsed.confidence ?? "LOW") as Confidence;
      const topic = parsed.newTopic ?? "new topic";

      return this.result({
        confidence,
        title: "TOPIC SHIFT",
        summary: topic,
        suggestedHudMode: "PASSIVE",
        expiresInMs: 4000,
        details: { newTopic: topic },
      });
    } catch {
      return this.noTrigger();
    }
  }
}
