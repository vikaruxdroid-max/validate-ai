// ── Shared types ────────────────────────────────────────────────────

export type Confidence = "HIGH" | "MED" | "LOW";
export type Verdict = "SUPPORTED" | "PARTIAL" | "DISPUTED";
export type HudMode = "LISTENING" | "CARD" | "ALERT" | "PASSIVE";
export type SuggestedHudMode = "COMPACT" | "CARD" | "ALERT" | "PASSIVE";

// ── Transcript ──────────────────────────────────────────────────────

export interface TranscriptSegment {
  text: string;
  ts: number;
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

// ── Analyzer framework ──────────────────────────────────────────────

export interface AnalyzerContext {
  sessionId: string;
  transcriptWindow: TranscriptSegment[];
  rollingText: string;
  enabledModules: EnabledModuleConfig[];
  recentOutputs: AnalyzerResult[];
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
  ttlMs: number;
  sourceAnalyzer: string;
}

// ── Validation (existing types preserved) ───────────────────────────

export interface ValidationResult {
  verdict: Verdict;
  summary: string;
  confidence: Confidence;
}
