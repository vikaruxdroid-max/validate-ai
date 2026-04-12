import { BaseAnalyzer } from "./base";
import type { AnalyzerContext, AnalyzerResult, Confidence, TranscriptSegment } from "../models/types";

const CONFIDENCE_THRESHOLD = 0.7;
const PACE_WINDOW_MS = 15_000;
const PACE_INCREASE_RATIO = 1.5; // 50% increase vs session baseline

export class StressCuesAnalyzer extends BaseAnalyzer {
  readonly name = "stressCues";
  readonly category = "analysis";
  readonly priority = 40;
  readonly schedule = "passive" as const;
  readonly intervalMs = 5000;
  readonly defaultCooldownMs = 15_000;

  // Session baseline: running average words-per-second
  private baselineWps = 0;
  private baselineSamples = 0;

  async analyze(ctx: AnalyzerContext): Promise<AnalyzerResult> {
    const now = Date.now();
    const signals: string[] = [];

    const recentSegments = ctx.transcriptWindow.filter(
      (s) => s.ts >= now - PACE_WINDOW_MS,
    );

    if (recentSegments.length < 2) return this.noTrigger();

    // ── Confidence drop check ───────────────────────────────────────
    const withConf = recentSegments.filter((s) => s.confidence !== undefined);
    if (withConf.length > 0) {
      const avgConf =
        withConf.reduce((sum, s) => sum + s.confidence!, 0) / withConf.length;
      if (avgConf < CONFIDENCE_THRESHOLD) {
        signals.push("hesitant delivery");
      }
    }

    // ── Pace increase vs session baseline ────────────────────────────
    const withDuration = recentSegments.filter(
      (s) => s.wordCount !== undefined && s.durationMs !== undefined && s.durationMs > 0,
    );

    if (withDuration.length >= 2) {
      const currentWps = this.computeWps(withDuration);

      // Update session baseline with exponential moving average
      if (currentWps > 0) {
        if (this.baselineSamples === 0) {
          this.baselineWps = currentWps;
        } else {
          this.baselineWps = this.baselineWps * 0.9 + currentWps * 0.1;
        }
        this.baselineSamples++;
      }

      // Only check after enough baseline samples
      if (this.baselineSamples >= 3 && this.baselineWps > 0) {
        if (currentWps / this.baselineWps >= PACE_INCREASE_RATIO) {
          signals.push("elevated pace");
        }
      }
    }

    // ── Silence ratio / fragmented speech ───────────────────────────
    if (recentSegments.length >= 3) {
      const gaps: number[] = [];
      for (let i = 1; i < recentSegments.length; i++) {
        const gap = recentSegments[i].ts - recentSegments[i - 1].ts;
        const prevDur = recentSegments[i - 1].durationMs ?? 500;
        const silenceGap = gap - prevDur;
        if (silenceGap > 0) gaps.push(silenceGap);
      }
      if (gaps.length >= 2) {
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        // Flag if average gap between utterances exceeds 3 seconds
        if (avgGap > 3000) {
          signals.push("fragmented speech");
        }
      }
    }

    if (signals.length === 0) return this.noTrigger();

    const confidence: Confidence = signals.length >= 2 ? "HIGH" : "MED";

    // Only surface MED+ confidence
    // (always true here since we only have MED or HIGH)

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

  private computeWps(segs: TranscriptSegment[]): number {
    const totalWords = segs.reduce((sum, s) => sum + s.wordCount!, 0);
    const totalMs = segs.reduce((sum, s) => sum + s.durationMs!, 0);
    return totalMs > 0 ? (totalWords / totalMs) * 1000 : 0;
  }
}
