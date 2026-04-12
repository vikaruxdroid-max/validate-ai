import { BaseAnalyzer } from "./base";
import type { AnalyzerContext, AnalyzerResult, Confidence } from "../models/types";

const CONFIDENCE_THRESHOLD = 0.7;
const PACE_WINDOW_MS = 15_000;
const PACE_INCREASE_RATIO = 1.5; // 50% increase in pace triggers alert

export class StressCuesAnalyzer extends BaseAnalyzer {
  readonly name = "stressCues";
  readonly category = "analysis";
  readonly priority = 40;
  readonly schedule = "passive" as const;
  readonly intervalMs = 5000;
  readonly defaultCooldownMs = 20_000;

  async analyze(ctx: AnalyzerContext): Promise<AnalyzerResult> {
    const now = Date.now();
    const signals: string[] = [];

    // Check Deepgram confidence drops
    const recentSegments = ctx.transcriptWindow.filter(
      (s) => s.ts >= now - PACE_WINDOW_MS,
    );

    if (recentSegments.length < 2) return this.noTrigger();

    const lowConfSegments = recentSegments.filter(
      (s) => s.confidence !== undefined && s.confidence < CONFIDENCE_THRESHOLD,
    );

    if (lowConfSegments.length > 0 && recentSegments.some((s) => s.confidence !== undefined)) {
      const avgConf =
        recentSegments
          .filter((s) => s.confidence !== undefined)
          .reduce((sum, s) => sum + s.confidence!, 0) /
        recentSegments.filter((s) => s.confidence !== undefined).length;

      if (avgConf < CONFIDENCE_THRESHOLD) {
        signals.push("hesitant delivery");
      }
    }

    // Check words-per-second pace increase
    const withDuration = recentSegments.filter(
      (s) => s.wordCount !== undefined && s.durationMs !== undefined && s.durationMs > 0,
    );

    if (withDuration.length >= 4) {
      const half = Math.floor(withDuration.length / 2);
      const firstHalf = withDuration.slice(0, half);
      const secondHalf = withDuration.slice(half);

      const wps = (segs: typeof withDuration) => {
        const totalWords = segs.reduce((sum, s) => sum + s.wordCount!, 0);
        const totalMs = segs.reduce((sum, s) => sum + s.durationMs!, 0);
        return totalMs > 0 ? (totalWords / totalMs) * 1000 : 0;
      };

      const firstWps = wps(firstHalf);
      const secondWps = wps(secondHalf);

      if (firstWps > 0 && secondWps / firstWps >= PACE_INCREASE_RATIO) {
        signals.push("elevated pace");
      }
    }

    if (signals.length === 0) return this.noTrigger();

    const confidence: Confidence = signals.length >= 2 ? "HIGH" : "MED";
    const label = signals.join(" + ");

    console.log("[StressCues] signals:", signals, "confidence:", confidence);

    return this.result({
      confidence,
      title: signals[0].toUpperCase(),
      summary: label,
      suggestedHudMode: "PASSIVE",
      expiresInMs: 4000,
      details: { signals },
    });
  }
}
