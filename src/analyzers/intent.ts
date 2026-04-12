import { BaseAnalyzer } from "./base";
import { claudeRequest } from "../services/claude";
import { INTENT_SYSTEM } from "../prompts/haiku";
import type { AnalyzerContext, AnalyzerResult, Confidence } from "../models/types";

const MIN_NEW_CHARS = 20;
const ALERT_INTENTS = new Set(["persuade", "deflect", "escalate"]);

export class IntentAnalyzer extends BaseAnalyzer {
  readonly name = "intent";
  readonly category = "conversation";
  readonly priority = 50;
  readonly schedule = "passive" as const;
  readonly intervalMs = 3000;
  readonly defaultCooldownMs = 15_000;

  private lastAnalyzedLength = 0;

  async analyze(ctx: AnalyzerContext): Promise<AnalyzerResult> {
    if (ctx.rollingText.length - this.lastAnalyzedLength < MIN_NEW_CHARS) {
      return this.noTrigger();
    }

    // Use last 30 seconds for intent classification
    const cutoff = Date.now() - 30_000;
    const recent = ctx.transcriptWindow
      .filter((s) => s.ts >= cutoff)
      .map((s) => s.text)
      .join(" ");

    if (recent.trim().length < 15) return this.noTrigger();

    this.lastAnalyzedLength = ctx.rollingText.length;

    const raw = await claudeRequest(
      "claude-haiku-4-5-20251001",
      INTENT_SYSTEM,
      recent,
      undefined,
      96,
    );

    console.log("[Intent] raw:", raw);

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return this.noTrigger();

    try {
      const parsed = JSON.parse(match[0]);
      const intent: string = parsed.intent?.toLowerCase() ?? "";
      const confidence = (parsed.confidence ?? "LOW") as Confidence;

      // Only show on HUD if persuade, deflect, or escalate at MED+ confidence
      if (!ALERT_INTENTS.has(intent)) return this.noTrigger();
      if (confidence === "LOW") return this.noTrigger();

      const label = intent.toUpperCase();
      const secondary = parsed.secondary ? ` / ${parsed.secondary}` : "";

      return this.result({
        confidence,
        title: `INTENT: ${label}`,
        summary: `${label} intent detected${secondary}`,
        suggestedHudMode: "PASSIVE",
        expiresInMs: 4000,
        details: { intent, secondary: parsed.secondary },
      });
    } catch {
      return this.noTrigger();
    }
  }
}
