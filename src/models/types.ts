// ── Shared types ────────────────────────────────────────────────────

export type Confidence = "HIGH" | "MED" | "LOW";
export type Verdict = "SUPPORTED" | "PARTIAL" | "DISPUTED";
export type HudMode = "LISTENING" | "CARD" | "ALERT" | "PASSIVE" | "LIST";
export type SuggestedHudMode = "COMPACT" | "CARD" | "ALERT" | "PASSIVE";

// ── Transcript ──────────────────────────────────────────────────────

export interface TranscriptSegment {
  text: string;
  ts: number;
  confidence?: number;
  wordCount?: number;
  durationMs?: number;
}

// ── Context types (future expansion) ────────────────────────────────

export interface EnabledModuleConfig {
  analyzer: string;
  enabled: boolean;
}

export interface MemorySummary {
  keyTopics: string[];
  recentEntities: string[];
  sessionNotes: string[];
}

export interface CalendarContext {
  currentEvent?: string;
  nextEvent?: string;
  participants?: string[];
}

export interface LocalContext {
  location?: string;
  timezone?: string;
}

export interface AcousticFeatureWindow {
  avgPitch?: number;
  pitchVariance?: number;
  speechRate?: number;
  pauseDuration?: number;
}

// ── Memory store interface ───────────────────────────────────────────

export interface CommitmentEntry {
  text: string;
  owner?: string;
  dueDate?: string;
  ts: number;
}

export interface IMemoryStore {
  pin(item: { text: string; source: string }): void;
  recall(query: string): Promise<{ found: boolean; matches?: string[]; context?: string }>;
  getSession(): {
    pinned: { id: string; text: string; source: string; ts: number }[];
    commitments: CommitmentEntry[];
    decisions: string[];
    entities: string[];
  };
  getCommitments(): CommitmentEntry[];
  clearSession(): void;
  addCommitment(entry: { text: string; owner?: string; dueDate?: string }): void;
  addDecision(text: string): void;
  addEntity(name: string): void;
}

// ── Analyzer framework ──────────────────────────────────────────────

export interface AnalyzerContext {
  sessionId: string;
  transcriptWindow: TranscriptSegment[];
  rollingText: string;
  enabledModules: EnabledModuleConfig[];
  recentOutputs: AnalyzerResult[];
  memoryStore?: IMemoryStore;
  memorySummary?: MemorySummary;
  calendarContext?: CalendarContext;
  localContext?: LocalContext;
  acousticFeatures?: AcousticFeatureWindow;
  nowIso: string;
}

export interface AnalyzerResult {
  analyzer: string;
  triggered: boolean;
  priority: number;
  confidence: Confidence;
  category: string;
  title: string;
  summary: string;
  details?: Record<string, unknown>;
  cooldownKey?: string;
  suggestedHudMode: SuggestedHudMode;
  expiresInMs?: number;
}

export interface HudPayload {
  mode: HudMode;
  title: string;
  verdict?: string;
  confidence?: Confidence;
  line1: string;
  line2?: string;
  listItems?: string[];
  ttlMs: number;
  sourceAnalyzer: string;
}

// ── Validation (existing types preserved) ───────────────────────────

export interface ValidationResult {
  verdict: Verdict;
  summary: string;
  confidence: Confidence;
}
