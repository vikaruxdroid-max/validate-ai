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
import { CLAUDE_SONNET, CLAUDE_HAIKU } from "../utils/models";
import { matchesPersona } from "../utils/personaUtils";

const BUFFER_SECONDS = 90;
const HUD_DEFAULT_TTL = 5000;
const HUD_SELF_ACTIVATE_TTL = 3000;
const SELF_DETECTION_WINDOW_MS = 60_000;
const MAX_RECENT_OUTPUTS = 20;
const ENTITY_EXTRACT_MIN_CHARS = 30;
const ENTITY_EXTRACT_INTERVAL_MS = 10_000;
const PASSIVE_CYCLE_INTERVAL_MS = 2000;
const AUTO_SAVE_INTERVAL_MS = 60_000;

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

const STATUS_TRIGGERS = [
  "even status", "even check status", "status", "even active",
];

const HELP_TRIGGERS = [
  "even help", "even commands", "help", "even guide",
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

const ANALYZER_DISPLAY_NAMES: Record<string, string> = {
  factValidation: "FACT VALID",
  commitments: "COMMITMENTS",
  decisions: "DECISIONS",
  intent: "INTENT",
  hedging: "HEDGING",
  contradiction: "CONTRADICTION",
  topicShift: "TOPIC SHIFT",
  stressCues: "STRESS CUES",
};

const HELP_ITEMS = [
  "even check \u2014 fact validate",
  "even why \u2014 explain result",
  "even recall \u2014 search memory",
  "even commitments \u2014 list commits",
  "even decisions \u2014 list decisions",
  "even summary \u2014 session summary",
  "even stats \u2014 session stats",
  "even status \u2014 analyzer status",
  "even toggle [name] \u2014 toggle analyzer",
  "even forget \u2014 clear memory",
  "even help \u2014 show commands",
];

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
  private personMentionCounts = new Map<string, number>();
  private proposedPersonaNames = new Set<string>();
  private pendingPersonaDetection: { name: string; sessionId: string; mentionCount: number } | null = null;
  private selfPersonaId: string | null = null;
  private selfPersonaName: string | null = null;
  private selfActivatedThisSession = false;
  private selfDetectionWindowStart = Date.now();
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

  /** Start polling loops and auto-save. Returns loaded memory item count. */
  async start(): Promise<number> {
    await this.memoryStore.load();
    this.passiveTimer = setInterval(() => this.runPassiveCycle(), PASSIVE_CYCLE_INTERVAL_MS);
    this.entityExtractTimer = setInterval(() => this.runEntityExtraction(), ENTITY_EXTRACT_INTERVAL_MS);
    this.memoryStore.startAutoSave(AUTO_SAVE_INTERVAL_MS);
    const session = this.memoryStore.getSession();
    return session.pinned.length + session.commitments.length +
      session.decisions.length + session.entities.length;
  }

  /** Returns a status badge string for the LISTENING display. */
  getAnalyzerBadge(): string {
    const total = Object.keys(ANALYZER_DISPLAY_NAMES).length;
    const off = this.disabledAnalyzers.size;
    const active = total - off;
    if (off === 0) return `${active} analyzers active`;
    return `${active} analyzers active (${off} off)`;
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

    // Prune segments older than buffer window
    const cutoff = now - BUFFER_SECONDS * 1000;
    while (this.transcript.length > 0 && this.transcript[0].ts < cutoff) {
      this.transcript.shift();
    }

    // ── Self-persona detection (first 60s of session only) ────────
    this.checkSelfDetection(text);

    // ── Active analyzer triggers ────────────────────────────────────
    if (!this.cooldown.isInCooldown(this.factValidation.name)) {
      const factTrigger = this.factValidation.checkTrigger(text);
      if (factTrigger) {
        await this.runActiveAnalyzer(this.factValidation);
        return;
      }
    }

    if (!this.cooldown.isInCooldown(this.recallAnalyzer.name)) {
      const recallTrigger = this.recallAnalyzer.checkTrigger(text);
      if (recallTrigger) {
        await this.runActiveAnalyzer(this.recallAnalyzer);
        return;
      }
    }

    // ── Direct triggers (no analyzer, handled inline) ───────────────
    if (detectTriggerFrom(text, EXPLAIN_WHY_TRIGGERS)) {
      await this.handleExplainWhy();
      return;
    }

    if (detectTriggerFrom(text, COMMITMENTS_LIST_TRIGGERS)) {
      this.showCommitmentsList();
      return;
    }

    if (detectTriggerFrom(text, DECISIONS_LIST_TRIGGERS)) {
      this.showDecisionsList();
      return;
    }

    if (detectTriggerFrom(text, SUMMARY_TRIGGERS)) {
      await this.handleSessionSummary();
      return;
    }

    if (detectTriggerFrom(text, STATS_TRIGGERS)) {
      this.handleSessionStats();
      return;
    }

    if (detectTriggerFrom(text, FORGET_TRIGGERS)) {
      await this.handleForget();
      return;
    }

    if (detectTriggerFrom(text, STATUS_TRIGGERS)) {
      this.handleStatus();
      return;
    }

    if (detectTriggerFrom(text, HELP_TRIGGERS)) {
      this.handleHelp();
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
        ttlMs: HUD_DEFAULT_TTL,
        sourceAnalyzer: "system",
      });
      this.scheduleHeartbeatRestore();
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
      ttlMs: HUD_DEFAULT_TTL,
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
        ttlMs: HUD_DEFAULT_TTL,
        sourceAnalyzer: "system",
      });
      this.scheduleHeartbeatRestore();
      return;
    }

    const items = decisions.map((d) => d.slice(0, 64));

    this.onHud({
      mode: "LIST",
      title: `${items.length} DECISIONS`,
      line1: "",
      listItems: items,
      ttlMs: HUD_DEFAULT_TTL,
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
        ttlMs: HUD_DEFAULT_TTL,
        sourceAnalyzer: "system",
      });
      this.scheduleHeartbeatRestore();
      return;
    }

    this.onHud({
      mode: "CARD",
      title: "CHECKING",
      line1: "C...",
      ttlMs: HUD_DEFAULT_TTL,
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
        CLAUDE_SONNET,
        EXPLAIN_WHY_SYSTEM,
        userMsg,
        undefined,
        256,
      );


      this.onHud({
        mode: "CARD",
        title: "WHY",
        line1: explanation.trim().slice(0, 200),
        ttlMs: HUD_DEFAULT_TTL,
        sourceAnalyzer: "system",
      });
      this.scheduleHeartbeatRestore();
    } catch (err: any) {
      console.error("[ExplainWhy] error:", err);
      this.onHud({
        mode: "ALERT",
        title: "ERROR",
        line1: err?.message ?? "Explain failed",
        ttlMs: HUD_DEFAULT_TTL,
        sourceAnalyzer: "system",
      });
      this.scheduleHeartbeatRestore();
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
      ttlMs: HUD_DEFAULT_TTL,
      sourceAnalyzer: "system",
    });

    // After 5 seconds, show Card 2: Haiku summary
    setTimeout(async () => {
      try {
        const fullStats =
          `Facts checked: ${this.factsCheckedCount}, ` +
          `Commitments: ${commitsCount}, ` +
          `Decisions: ${decisionsCount}, ` +
          `Contradictions: ${this.contradictionsCount}`;

        const summary = await claudeRequest(
          CLAUDE_HAIKU,
          SESSION_SUMMARY_SYSTEM,
          fullStats,
          undefined,
          96,
        );


        this.onHud({
          mode: "CARD",
          title: "SUMMARY",
          line1: summary.trim().slice(0, 160),
          ttlMs: HUD_DEFAULT_TTL,
          sourceAnalyzer: "system",
        });
        this.scheduleHeartbeatRestore();
      } catch (err) {
        console.warn("[SessionSummary] Haiku error:", err);
        this.emitListening();
      }
    }, 5000);
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
      ttlMs: HUD_DEFAULT_TTL,
      sourceAnalyzer: "system",
    });
    this.scheduleHeartbeatRestore();
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
      ttlMs: HUD_DEFAULT_TTL,
      sourceAnalyzer: "system",
    });
    this.scheduleHeartbeatRestore();
  }

  private handleToggle(analyzerKey: string): void {
    const analyzerName = TOGGLE_ANALYZERS[analyzerKey];
    if (!analyzerName) {
      return;
    }

    const wasDisabled = this.disabledAnalyzers.has(analyzerName);
    if (wasDisabled) {
      this.disabledAnalyzers.delete(analyzerName);
    } else {
      this.disabledAnalyzers.add(analyzerName);
    }

    const state = wasDisabled ? "ON" : "OFF";

    this.onHud({
      mode: "PASSIVE",
      title: `${analyzerKey.toUpperCase()}: ${state}`,
      line1: `${analyzerKey.toUpperCase()}: ${state}`,
      ttlMs: HUD_DEFAULT_TTL,
      sourceAnalyzer: "system",
    });
    this.scheduleHeartbeatRestore();
  }

  private handleStatus(): void {
    const names = Object.keys(ANALYZER_DISPLAY_NAMES);
    const items = names.map((name) => {
      const display = ANALYZER_DISPLAY_NAMES[name];
      const enabled = !this.disabledAnalyzers.has(name);
      return enabled ? `\u2713 ${display}` : `\u2717 ${display}`;
    });

    this.onHud({
      mode: "LIST",
      title: "ANALYZER STATUS",
      line1: "",
      listItems: items.slice(0, 20),
      ttlMs: HUD_DEFAULT_TTL,
      sourceAnalyzer: "system",
    });
  }

  private handleHelp(): void {
    this.onHud({
      mode: "LIST",
      title: "COMMANDS",
      line1: "",
      listItems: HELP_ITEMS,
      ttlMs: HUD_DEFAULT_TTL,
      sourceAnalyzer: "system",
    });
  }

  private async runEntityExtraction(): Promise<void> {
    const rollingText = this.transcript.map((s) => s.text).join(" ");
    if (rollingText.length - this.lastEntityExtractLength < ENTITY_EXTRACT_MIN_CHARS) return;

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
        CLAUDE_HAIKU,
        ENTITY_EXTRACTION_SYSTEM,
        recent,
        undefined,
        256,
      );

      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return;

      const parsed = JSON.parse(match[0]);
      const entities: Array<{ text: string; type: string; context?: string }> = parsed.entities ?? [];

      for (const e of entities) {
        if (e.text && e.type) {
          this.memoryStore.addEntity({
            text: e.text,
            type: e.type,
            context: e.context ?? "",
          });
        }
      }

      // Persona detection: track PERSON mentions and auto-link
      const currentSessionId = this.memoryStore.getCurrentSessionId();
      for (const e of entities) {
        if (e.type === "PERSON" && e.text) {
          const name = e.text;
          const count = (this.personMentionCounts.get(name) || 0) + 1;
          this.personMentionCounts.set(name, count);

          const existingPersonas = this.memoryStore.getPersonas();
          const matchedPersona = existingPersonas.find(p => matchesPersona(name, p));

          if (matchedPersona && currentSessionId) {
            this.memoryStore.linkArtifactToPersona(matchedPersona.id, currentSessionId);
          }

          if (count >= 2 && !this.pendingPersonaDetection && !matchedPersona
              && !this.proposedPersonaNames.has(name.toLowerCase())) {
            this.proposedPersonaNames.add(name.toLowerCase());
            this.pendingPersonaDetection = {
              name,
              sessionId: currentSessionId || this.sessionId,
              mentionCount: count,
            };
          }
        }
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
      line1: "C...",
      ttlMs: HUD_DEFAULT_TTL,
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
        ttlMs: HUD_DEFAULT_TTL,
        sourceAnalyzer: analyzer.name,
      });
      this.scheduleHeartbeatRestore();
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
    if (this.recentOutputs.length > MAX_RECENT_OUTPUTS) this.recentOutputs.shift();

    // Track stats for session summary
    if (result.analyzer === "factValidation" && result.triggered) {
      this.factsCheckedCount++;
    }
    if (result.analyzer === "contradiction" && result.triggered) {
      this.contradictionsCount++;
    }

    if (!result.triggered) return;

    if (!this.prioritizer.shouldDisplay(result)) return;

    const payload = this.toHudPayload(result);
    this.onHud(payload);

    const ttl = result.expiresInMs ?? 5000;
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
      ttlMs: result.expiresInMs ?? 5000,
      sourceAnalyzer: result.analyzer,
    };
  }

  private scheduleHeartbeatRestore(delayMs = HUD_DEFAULT_TTL): void {
    setTimeout(() => this.emitListening(), delayMs);
  }

  private emitListening(): void {
    this.onHud({
      mode: "LISTENING",
      title: "LISTENING",
      line1: "L...",
      ttlMs: 0,
      sourceAnalyzer: "system",
    });
  }

  // ── Public getters for phone companion UI ─────────────────────────

  getRecentOutputs(): AnalyzerResult[] {
    return [...this.recentOutputs];
  }

  getStats() {
    return {
      factsChecked: this.factsCheckedCount,
      contradictions: this.contradictionsCount,
      sessionStartTs: this.sessionStartTs,
    };
  }

  getDisabledAnalyzers(): string[] {
    return [...this.disabledAnalyzers];
  }

  getMemoryStore() {
    return this.memoryStore;
  }

  getPendingPersonaDetection() {
    return this.pendingPersonaDetection;
  }

  clearPendingPersonaDetection(): void {
    this.pendingPersonaDetection = null;
  }

  // ── Self persona ──────────────────────────────────────────────────

  getSelfPersonaId(): string | null {
    return this.selfPersonaId;
  }

  getSelfPersonaName(): string | null {
    return this.selfPersonaName;
  }

  /** Called by main.ts on session START to open a new 60s detection window. */
  resetSelfDetection(): void {
    this.selfDetectionWindowStart = Date.now();
    this.selfActivatedThisSession = false;
  }

  /** Called by main.ts on session END. */
  clearSelfPersona(): void {
    this.selfPersonaId = null;
    this.selfPersonaName = null;
    this.selfActivatedThisSession = false;
  }

  private checkSelfDetection(text: string): void {
    if (this.selfActivatedThisSession) return;
    if (Date.now() - this.selfDetectionWindowStart > SELF_DETECTION_WINDOW_MS) return;

    // Normalize: lowercase, replace curly apostrophes with straight, collapse whitespace, strip trailing punctuation
    const norm = text.toLowerCase()
      .replace(/[\u2018\u2019\u0060\u00b4\u2032\u2035]/g, "'")
      .replace(/[^a-z' ]/g, "")
      .replace(/ +/g, " ")
      .trim();

    // Strip apostrophes for pattern matching (handles "it's", "its", "it\u2019s" identically)
    const stripped = norm.replace(/'/g, "");

    const patterns: RegExp[] = [
      /^hey its me (.+)$/,
      /^its me (.+)$/,
      /^this is (.+)$/,
      /^its (.+) here$/,
      /^hi its (.+)$/,
      /^hey this is (.+)$/,
    ];

    let extracted: string | null = null;
    for (const pat of patterns) {
      const m = stripped.match(pat);
      if (m?.[1]) { extracted = m[1].trim(); break; }
    }
    if (!extracted) return;

    // Validate: must be 2+ chars, must be alphabetic (no pure numbers)
    extracted = extracted.replace(/[^a-z ]/g, "").trim();
    if (extracted.length < 2 || !/[a-z]/.test(extracted)) {
      console.warn("[SelfDetect] name validation failed for:", JSON.stringify(extracted));
      return;
    }

    // Title case
    const name = extracted.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    this.activateSelfMode(name);
  }

  private activateSelfMode(name: string): void {
    this.selfActivatedThisSession = true;

    // Match existing personas by name or alias — check for ambiguity
    const personas = this.memoryStore.getPersonas();
    const nameL = name.toLowerCase();
    const matches = personas.filter(p =>
      p.name.toLowerCase() === nameL ||
      (p.aliases || []).some(a => a.toLowerCase() === nameL),
    );

    if (matches.length > 1) {
      console.warn("[SelfDetect] ambiguous match for", name, "— matched", matches.length, "personas, skipping");
      this.selfActivatedThisSession = false; // allow retry with different phrase
      return;
    }

    if (matches.length === 1) {
      this.memoryStore.markPersonaAsSelf(matches[0].id);
      this.selfPersonaId = matches[0].id;
      this.selfPersonaName = matches[0].name;
    } else {
      const sid = this.memoryStore.getCurrentSessionId() ?? undefined;
      const persona = this.memoryStore.createPersona(name, sid);
      this.memoryStore.markPersonaAsSelf(persona.id);
      this.selfPersonaId = persona.id;
      this.selfPersonaName = name;
    }

    // HUD: show name for 3 seconds
    this.onHud({
      mode: "CARD",
      title: name.toUpperCase(),
      line1: name.toUpperCase(),
      ttlMs: HUD_SELF_ACTIVATE_TTL,
      sourceAnalyzer: "system",
    });
    this.scheduleHeartbeatRestore(HUD_SELF_ACTIVATE_TTL);

    console.log("Self persona activated:", name, "(id:", this.selfPersonaId, ")");
  }
}
