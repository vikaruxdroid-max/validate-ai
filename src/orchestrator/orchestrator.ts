import type {
  TranscriptSegment,
  AnalyzerContext,
  AnalyzerResult,
  HudPayload,
} from "../models/types";
import type { BaseAnalyzer } from "../analyzers/base";
import { FactValidationAnalyzer } from "../analyzers/factValidation";
import { Scheduler } from "./scheduler";
import { Prioritizer } from "./prioritizer";
import { CooldownEngine } from "./cooldown";

const BUFFER_SECONDS = 90;

export class Orchestrator {
  private scheduler = new Scheduler();
  private prioritizer = new Prioritizer();
  private cooldown = new CooldownEngine();
  private transcript: TranscriptSegment[] = [];
  private recentOutputs: AnalyzerResult[] = [];
  private sessionId: string;
  private onHud: (payload: HudPayload) => void;
  private passiveTimer: ReturnType<typeof setInterval> | null = null;
  private factValidation: FactValidationAnalyzer;

  constructor(onHud: (payload: HudPayload) => void) {
    this.sessionId = crypto.randomUUID();
    this.onHud = onHud;

    // Register the migrated fact-validation analyzer
    this.factValidation = new FactValidationAnalyzer();
    this.scheduler.register(this.factValidation);
  }

  /** Register additional analyzers (stubs or future implementations). */
  registerAnalyzers(analyzers: BaseAnalyzer[]): void {
    for (const a of analyzers) {
      this.scheduler.register(a);
    }
  }

  /** Start the passive analyzer polling loop. */
  start(): void {
    this.passiveTimer = setInterval(() => this.runPassiveCycle(), 2000);
  }

  stop(): void {
    if (this.passiveTimer) {
      clearInterval(this.passiveTimer);
      this.passiveTimer = null;
    }
  }

  /** Called when a new final transcript segment arrives from Deepgram. */
  async handleTranscript(text: string): Promise<void> {
    const now = Date.now();
    this.transcript.push({ text, ts: now });
    console.log("[STT]", text);

    // Prune segments older than buffer window
    const cutoff = now - BUFFER_SECONDS * 1000;
    while (this.transcript.length > 0 && this.transcript[0].ts < cutoff) {
      this.transcript.shift();
    }

    // Check for fact-validation trigger in the latest segment
    if (this.cooldown.isInCooldown(this.factValidation.name)) return;

    const trigger = this.factValidation.checkTrigger(text);
    if (trigger) {
      console.log("[Orchestrator] trigger matched:", trigger, "in:", text);
      await this.runActiveAnalyzer(this.factValidation);
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  private buildContext(): AnalyzerContext {
    return {
      sessionId: this.sessionId,
      transcriptWindow: [...this.transcript],
      rollingText: this.transcript.map((s) => s.text).join(" "),
      enabledModules: [],
      recentOutputs: [...this.recentOutputs],
      nowIso: new Date().toISOString(),
    };
  }

  private async runActiveAnalyzer(analyzer: BaseAnalyzer): Promise<void> {
    // Set cooldown immediately to prevent re-trigger during async work
    this.cooldown.setCooldown(analyzer.name, analyzer.defaultCooldownMs);

    // Show "checking" state on HUD
    this.onHud({
      mode: "CARD",
      title: "CHECKING",
      line1: "CHECKING...",
      ttlMs: 30_000,
      sourceAnalyzer: analyzer.name,
    });

    try {
      const ctx = this.buildContext();
      const result = await analyzer.analyze(ctx);
      this.handleResult(result);
    } catch (err: any) {
      console.error("[Orchestrator] analyzer error:", err);
      this.onHud({
        mode: "ALERT",
        title: "ERROR",
        line1: err?.message ?? "Analysis failed",
        ttlMs: 5000,
        sourceAnalyzer: analyzer.name,
      });
      setTimeout(() => this.emitListening(), 5000);
    }
  }

  private async runPassiveCycle(): Promise<void> {
    const now = Date.now();
    const due = this.scheduler.getPassiveDue(now);

    for (const analyzer of due) {
      if (this.cooldown.isInCooldown(analyzer.name)) continue;

      try {
        const ctx = this.buildContext();
        const result = await analyzer.analyze(ctx);
        if (result.triggered) {
          this.handleResult(result);
        }
      } catch (err) {
        console.warn(
          "[Orchestrator] passive analyzer error:",
          analyzer.name,
          err,
        );
      }
    }
  }

  private handleResult(result: AnalyzerResult): void {
    this.recentOutputs.push(result);
    if (this.recentOutputs.length > 20) this.recentOutputs.shift();

    if (!result.triggered) return;

    if (!this.prioritizer.shouldDisplay(result)) {
      console.log(
        "[Orchestrator] suppressed:",
        result.analyzer,
        "priority:",
        result.priority,
      );
      return;
    }

    const payload = this.toHudPayload(result);
    this.onHud(payload);

    // Return to listening after result expires
    const ttl = result.expiresInMs ?? 10_000;
    setTimeout(() => {
      if (this.prioritizer.getActive()?.analyzer === result.analyzer) {
        this.prioritizer.clear();
        this.emitListening();
      }
    }, ttl);
  }

  private toHudPayload(result: AnalyzerResult): HudPayload {
    const verdict = result.details?.verdict as string | undefined;
    return {
      mode:
        result.suggestedHudMode === "COMPACT"
          ? "CARD"
          : (result.suggestedHudMode as HudPayload["mode"]),
      title: result.title,
      verdict,
      confidence: result.confidence,
      line1: result.summary,
      ttlMs: result.expiresInMs ?? 10_000,
      sourceAnalyzer: result.analyzer,
    };
  }

  private emitListening(): void {
    this.onHud({
      mode: "LISTENING",
      title: "LISTENING",
      line1: "LISTENING...",
      ttlMs: 0,
      sourceAnalyzer: "system",
    });
  }
}
