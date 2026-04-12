import type {
  TranscriptSegment,
  AnalyzerContext,
  AnalyzerResult,
  HudPayload,
} from "../models/types";
import type { BaseAnalyzer } from "../analyzers/base";
import { FactValidationAnalyzer } from "../analyzers/factValidation";
import { RecallAnalyzer } from "../analyzers/recall";
import { MemoryStore } from "../services/memoryStore";
import { claudeRequest } from "../services/claude";
import { EXPLAIN_WHY_SYSTEM } from "../prompts/sonnet";
import { SESSION_SUMMARY_SYSTEM, ENTITY_EXTRACTION_SYSTEM } from "../prompts/haiku";
import { Scheduler } from "./scheduler";
import { Prioritizer } from "./prioritizer";
import { CooldownEngine } from "./cooldown";

const BUFFER_SECONDS = 90;

// ── Trigger phrase tables ───────────────────────────────────────────

const COMMITMENTS_LIST_TRIGGERS = [
  "even commitments", "even commitment", "even commit list", "list commitments",
];

const DECISIONS_LIST_TRIGGERS = [
  "even decisions", "even decision", "list decisions", "even decide",
];

const EXPLAIN_WHY_TRIGGERS = [
  "even why", "even y", "even wire", "even wise",
];

const SUMMARY_TRIGGERS = [
  "even summary", "even sum", "even summarize", "summary",
];

const STATS_TRIGGERS = [
  "even stats", "even stat", "even statistics", "stats",
];

const FORGET_TRIGGERS = [
  "even forget", "even clear", "even reset",
];

const TOGGLE_ANALYZERS: Record<string, string> = {
  hedging: "hedging",
  intent: "intent",
  topic: "topicShift",
  stress: "stressCues",
  contradiction: "contradiction",
  commitments: "commitments",
  decisions: "decisions",
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/ +/g, " ")
    .trim();
}

function detectTriggerFrom(text: string, triggers: string[]): string | null {
  const clean = normalize(text);
  for (const t of triggers) {
    if (clean.includes(t)) return t;
  }
  return null;
}

// ── Orchestrator ────────────────────────────────────────────────────

export class Orchestrator {
  private scheduler = new Scheduler();
  private prioritizer = new Prioritizer();
  private cooldown = new CooldownEngine();
  private memoryStore = new MemoryStore();
  private transcript: TranscriptSegment[] = [];
  private recentOutputs: AnalyzerResult[] = [];
  private disabledAnalyzers = new Set<string>();
  private factsCheckedCount = 0;
  private contradictionsCount = 0;
  private sessionStartTs = Date.now();
  private sessionId: string;
  private onHud: (payload: HudPayload) => void;
  private passiveTimer: ReturnType<typeof setInterval> | null = null;
  private entityExtractTimer: ReturnType<typeof setInterval> | null = null;
  private lastEntityExtractLength = 0;
  private factValidation: FactValidationAnalyzer;
  private recallAnalyzer: RecallAnalyzer;

  constructor(onHud: (payload: HudPayload) => void) {
    this.sessionId = crypto.randomUUID();
    this.onHud = onHud;

    // Register built-in active analyzers
    this.factValidation = new FactValidationAnalyzer();
    this.recallAnalyzer = new RecallAnalyzer();
    this.scheduler.register(this.factValidation);
    this.scheduler.register(this.recallAnalyzer);
  }

  /** Register additional analyzers (stubs or future implementations). */
  registerAnalyzers(analyzers: BaseAnalyzer[]): void {
    for (const a of analyzers) {
      this.scheduler.register(a);
    }
  }

  /** Start the passive analyzer polling loop, entity extractor, and auto-save. */
  async start(): Promise<void> {
    await this.memoryStore.load();
    this.passiveTimer = setInterval(() => this.runPassiveCycle(), 2000);
    this.entityExtractTimer = setInterval(() => this.runEntityExtraction(), 10_000);
    this.memoryStore.startAutoSave(60_000);
  }

  stop(): void {
    if (this.passiveTimer) {
      clearInterval(this.passiveTimer);
      this.passiveTimer = null;
    }
    if (this.entityExtractTimer) {
      clearInterval(this.entityExtractTimer);
      this.entityExtractTimer = null;
    }
    this.memoryStore.stopAutoSave();
    this.memoryStore.save();
  }

  /** Called when a new final transcript segment arrives from Deepgram. */
  async handleTranscript(
    text: string,
    meta?: { confidence?: number; wordCount?: number; durationMs?: number },
  ): Promise<void> {
    const now = Date.now();
    this.transcript.push({
      text,
      ts: now,
      confidence: meta?.confidence,
      wordCount: meta?.wordCount,
      durationMs: meta?.durationMs,
    });
    console.log("[STT]", text);

    // Prune segments older than buffer window
    const cutoff = now - BUFFER_SECONDS * 1000;
    while (this.transcript.length > 0 && this.transcript[0].ts < cutoff) {
      this.transcript.shift();
    }

    // ── Active analyzer triggers ────────────────────────────────────
    if (!this.cooldown.isInCooldown(this.factValidation.name)) {
      const factTrigger = this.factValidation.checkTrigger(text);
      if (factTrigger) {
        console.log("[Orchestrator] trigger matched:", factTrigger, "in:", text);
        await this.runActiveAnalyzer(this.factValidation);
        return;
      }
    }

    if (!this.cooldown.isInCooldown(this.recallAnalyzer.name)) {
      const recallTrigger = this.recallAnalyzer.checkTrigger(text);
      if (recallTrigger) {
        console.log("[Orchestrator] recall trigger:", recallTrigger);
        await this.runActiveAnalyzer(this.recallAnalyzer);
        return;
      }
    }

    // ── Direct triggers (no analyzer, handled inline) ───────────────
    if (detectTriggerFrom(text, EXPLAIN_WHY_TRIGGERS)) {
      console.log("[Orchestrator] explain-why trigger");
      await this.handleExplainWhy();
      return;
    }

    if (detectTriggerFrom(text, COMMITMENTS_LIST_TRIGGERS)) {
      console.log("[Orchestrator] commitments-list trigger");
      this.showCommitmentsList();
      return;
    }

    if (detectTriggerFrom(text, DECISIONS_LIST_TRIGGERS)) {
      console.log("[Orchestrator] decisions-list trigger");
      this.showDecisionsList();
      return;
    }

    if (detectTriggerFrom(text, SUMMARY_TRIGGERS)) {
      console.log("[Orchestrator] session-summary trigger");
      await this.handleSessionSummary();
      return;
    }

    if (detectTriggerFrom(text, STATS_TRIGGERS)) {
      console.log("[Orchestrator] session-stats trigger");
      this.handleSessionStats();
      return;
    }

    if (detectTriggerFrom(text, FORGET_TRIGGERS)) {
      console.log("[Orchestrator] forget trigger");
      await this.handleForget();
      return;
    }

    // Toggle: "even toggle hedging" etc.
    const toggleMatch = normalize(text).match(/even toggle (\w+)/);
    if (toggleMatch) {
      const analyzerKey = toggleMatch[1];
      this.handleToggle(analyzerKey);
    }
  }

  // ── Inline trigger handlers ───────────────────────────────────────

  private showCommitmentsList(): void {
    const commitments = this.memoryStore.getCommitments();

    if (commitments.length === 0) {
      this.onHud({
        mode: "CARD",
        title: "COMMITMENTS",
        line1: "NO COMMITMENTS YET",
        ttlMs: 5000,
        sourceAnalyzer: "system",
      });
      setTimeout(() => this.emitListening(), 5000);
      return;
    }

    const items = commitments.map((c) => {
      const parts = [c.text];
      if (c.owner) parts.push(`(${c.owner})`);
      if (c.dueDate) parts.push(`by ${c.dueDate}`);
      return parts.join(" ").slice(0, 64);
    });

    this.onHud({
      mode: "LIST",
      title: `${items.length} COMMITMENTS`,
      line1: "",
      listItems: items,
      ttlMs: 30_000,
      sourceAnalyzer: "system",
    });
  }

  private showDecisionsList(): void {
    const decisions = this.memoryStore.getDecisions();

    if (decisions.length === 0) {
      this.onHud({
        mode: "CARD",
        title: "DECISIONS",
        line1: "NO DECISIONS YET",
        ttlMs: 5000,
        sourceAnalyzer: "system",
      });
      setTimeout(() => this.emitListening(), 5000);
      return;
    }

    const items = decisions.map((d) => d.slice(0, 64));

    this.onHud({
      mode: "LIST",
      title: `${items.length} DECISIONS`,
      line1: "",
      listItems: items,
      ttlMs: 30_000,
      sourceAnalyzer: "system",
    });
  }

  private async handleExplainWhy(): Promise<void> {
    // Find the last fact validation result in recentOutputs
    const lastFact = [...this.recentOutputs]
      .reverse()
      .find((r) => r.analyzer === "factValidation" && r.triggered);

    if (!lastFact || !lastFact.details?.verdict) {
      this.onHud({
        mode: "CARD",
        title: "WHY",
        line1: "NO RECENT CHECK",
        ttlMs: 5000,
        sourceAnalyzer: "system",
      });
      setTimeout(() => this.emitListening(), 5000);
      return;
    }

    this.onHud({
      mode: "CARD",
      title: "CHECKING",
      line1: "CHECKING...",
      ttlMs: 30_000,
      sourceAnalyzer: "system",
    });

    try {
      const verdict = lastFact.details.verdict as string;
      const claim = lastFact.details.claim as string;
      const summary = lastFact.summary;

      const userMsg =
        `Claim: "${claim}"\n` +
        `Verdict: ${verdict}\n` +
        `Summary: ${summary}`;

      const explanation = await claudeRequest(
        "claude-sonnet-4-20250514",
        EXPLAIN_WHY_SYSTEM,
        userMsg,
        undefined,
        256,
      );

      console.log("[ExplainWhy] response:", explanation);

      this.onHud({
        mode: "CARD",
        title: "WHY",
        line1: explanation.trim().slice(0, 200),
        ttlMs: 15_000,
        sourceAnalyzer: "system",
      });
      setTimeout(() => this.emitListening(), 15_000);
    } catch (err: any) {
      console.error("[ExplainWhy] error:", err);
      this.onHud({
        mode: "ALERT",
        title: "ERROR",
        line1: err?.message ?? "Explain failed",
        ttlMs: 5000,
        sourceAnalyzer: "system",
      });
      setTimeout(() => this.emitListening(), 5000);
    }
  }

  private async handleSessionSummary(): Promise<void> {
    const session = this.memoryStore.getSession();
    const commitsCount = session.commitments.length;
    const decisionsCount = session.decisions.length;

    const statsLine = `${this.factsCheckedCount} facts \u00b7 ${commitsCount} commits \u00b7 ${decisionsCount} decisions`;

    // Card 1: stats
    this.onHud({
      mode: "CARD",
      title: "SESSION",
      line1: statsLine,
      ttlMs: 6000,
      sourceAnalyzer: "system",
    });

    // After 6 seconds, show Card 2: Haiku summary
    setTimeout(async () => {
      try {
        const fullStats =
          `Facts checked: ${this.factsCheckedCount}, ` +
          `Commitments: ${commitsCount}, ` +
          `Decisions: ${decisionsCount}, ` +
          `Contradictions: ${this.contradictionsCount}`;

        const summary = await claudeRequest(
          "claude-haiku-4-5-20251001",
          SESSION_SUMMARY_SYSTEM,
          fullStats,
          undefined,
          96,
        );

        console.log("[SessionSummary] response:", summary);

        this.onHud({
          mode: "CARD",
          title: "SUMMARY",
          line1: summary.trim().slice(0, 160),
          ttlMs: 8000,
          sourceAnalyzer: "system",
        });
        setTimeout(() => this.emitListening(), 8000);
      } catch (err) {
        console.warn("[SessionSummary] Haiku error:", err);
        this.emitListening();
      }
    }, 6000);
  }

  private handleSessionStats(): void {
    const session = this.memoryStore.getSession();
    const mins = Math.round((Date.now() - this.sessionStartTs) / 60_000);
    const l1 = `${this.factsCheckedCount} facts \u00b7 ${session.commitments.length} commits \u00b7 ${session.decisions.length} decisions`;
    const l2 = `${session.entities.length} entities \u00b7 ${this.contradictionsCount} contradictions \u00b7 ${mins}m session`;

    this.onHud({
      mode: "CARD",
      title: "STATS",
      line1: l1,
      line2: l2,
      ttlMs: 8000,
      sourceAnalyzer: "system",
    });
    setTimeout(() => this.emitListening(), 8000);
  }

  private async handleForget(): Promise<void> {
    this.memoryStore.clearSession();
    await this.memoryStore.deleteFile();
    this.factsCheckedCount = 0;
    this.contradictionsCount = 0;
    this.onHud({
      mode: "PASSIVE",
      title: "MEMORY CLEARED",
      line1: "MEMORY CLEARED",
      ttlMs: 3000,
      sourceAnalyzer: "system",
    });
    setTimeout(() => this.emitListening(), 3000);
  }

  private handleToggle(analyzerKey: string): void {
    const analyzerName = TOGGLE_ANALYZERS[analyzerKey];
    if (!analyzerName) {
      console.log("[Orchestrator] unknown toggle target:", analyzerKey);
      return;
    }

    const wasDisabled = this.disabledAnalyzers.has(analyzerName);
    if (wasDisabled) {
      this.disabledAnalyzers.delete(analyzerName);
    } else {
      this.disabledAnalyzers.add(analyzerName);
    }

    const state = wasDisabled ? "ON" : "OFF";
    console.log("[Orchestrator] toggle:", analyzerName, state);

    this.onHud({
      mode: "PASSIVE",
      title: `${analyzerKey.toUpperCase()}: ${state}`,
      line1: `${analyzerKey.toUpperCase()}: ${state}`,
      ttlMs: 3000,
      sourceAnalyzer: "system",
    });
    setTimeout(() => this.emitListening(), 3000);
  }

  private async runEntityExtraction(): Promise<void> {
    const rollingText = this.transcript.map((s) => s.text).join(" ");
    if (rollingText.length - this.lastEntityExtractLength < 30) return;

    const now = Date.now();
    const cutoff = now - 30_000;
    const recent = this.transcript
      .filter((s) => s.ts >= cutoff)
      .map((s) => s.text)
      .join(" ");

    if (recent.trim().length < 15) return;

    this.lastEntityExtractLength = rollingText.length;

    try {
      const raw = await claudeRequest(
        "claude-haiku-4-5-20251001",
        ENTITY_EXTRACTION_SYSTEM,
        recent,
        undefined,
        256,
      );

      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return;

      const parsed = JSON.parse(match[0]);
      const entities: any[] = parsed.entities ?? [];

      for (const e of entities) {
        if (e.text && e.type) {
          this.memoryStore.addEntity({
            text: e.text,
            type: e.type,
            context: e.context ?? "",
          });
        }
      }

      if (entities.length > 0) {
        console.log("[EntityExtractor] extracted:", entities.length, "entities");
      }
    } catch (err) {
      console.warn("[EntityExtractor] error:", err);
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
      memoryStore: this.memoryStore,
      nowIso: new Date().toISOString(),
    };
  }

  private async runActiveAnalyzer(analyzer: BaseAnalyzer): Promise<void> {
    this.cooldown.setCooldown(analyzer.name, analyzer.defaultCooldownMs);

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
      if (this.disabledAnalyzers.has(analyzer.name)) continue;

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

    // Track stats for session summary
    if (result.analyzer === "factValidation" && result.triggered) {
      this.factsCheckedCount++;
    }
    if (result.analyzer === "contradiction" && result.triggered) {
      this.contradictionsCount++;
    }

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
    const hasNewlines = result.summary.includes("\n");
    const prior = result.details?.prior as string | undefined;
    const line2 = prior
      ? `Was: ${prior}`
      : hasNewlines
        ? result.summary
        : undefined;
    return {
      mode:
        result.suggestedHudMode === "COMPACT"
          ? "CARD"
          : (result.suggestedHudMode as HudPayload["mode"]),
      title: result.title,
      verdict,
      confidence: result.confidence,
      line1: result.summary,
      line2,
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
