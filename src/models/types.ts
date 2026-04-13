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
  sessionId?: string;
}

export type EntityType = "PERSON" | "DATE" | "NUMBER" | "PLACE" | "ORGANIZATION";

export interface EntityEntry {
  text: string;
  type: EntityType;
  context: string;
  ts: number;
  sessionId?: string;
}

export interface PinnedItem {
  id: string;
  text: string;
  source: string;
  ts: number;
  sessionId?: string;
}

export interface SessionEntry {
  id: string;
  label: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "completed";
  stats: {
    factsChecked: number;
    commitmentsStored: number;
    decisionsStored: number;
    entitiesTracked: number;
    contradictionsDetected: number;
  };
}

export interface PersonaBrief {
  who: string;
  lastInteraction: string;
  openCommitments: string[];
  openQuestions: string[];
  signals: string[];
  behavioralPatterns: Array<{
    signal: string;
    observation: string;
    confidence: string;
    evidenceCount: number;
    caveat: string;
  }>;
  suggestedFollowUps: string[];
  nextSteps: string[];
  generatedAt: number;
}

export interface PersonaSignalSnapshot {
  sessionId: string;
  ts: number;
  contradictions: number;
  hedgingScores: number[];
  intentCounts: Record<string, number>;
  topicShifts: number;
  commitmentsMade: number;
}

export interface Persona {
  id: string;
  name: string;
  aliases: string[];
  createdAt: string;
  lastSeenAt: string;
  sessionIds: string[];
  notes: string;
  brief?: PersonaBrief;
  signalSnapshots?: PersonaSignalSnapshot[];
}

export interface IMemoryStore {
  pin(item: { text: string; source: string }, sessionId?: string): void;
  recall(query: string): Promise<{ found: boolean; matches?: string[]; context?: string }>;
  getSession(): {
    pinned: PinnedItem[];
    commitments: CommitmentEntry[];
    decisions: string[];
    entities: EntityEntry[];
  };
  getCommitments(): CommitmentEntry[];
  getDecisions(): string[];
  getEntities(): EntityEntry[];
  getSessions(): SessionEntry[];
  getCurrentSessionId(): string | null;
  startSession(): string;
  endSession(factsChecked: number, contradictions: number): void;
  clearSession(): void;
  addCommitment(entry: { text: string; owner?: string; dueDate?: string }, sessionId?: string): void;
  addDecision(text: string, sessionId?: string): void;
  addEntity(entry: { text: string; type: EntityType; context: string }, sessionId?: string): void;
  createPersona(name: string, sessionId?: string): Persona;
  getPersonas(): Persona[];
  getPersonaById(id: string): Persona | undefined;
  updatePersona(id: string, updates: Partial<Pick<Persona, "name" | "aliases" | "notes">>): void;
  linkArtifactToPersona(personaId: string, sessionId: string): void;
  checkPersonaLinkForArtifact(text: string, sessionId?: string): void;
  retroactiveLinkPersona(personaId: string): void;
  setPersonaBrief(personaId: string, brief: PersonaBrief): void;
  addPersonaSignalSnapshot(personaId: string, snapshot: PersonaSignalSnapshot): void;
  setCommitmentStatus(commitmentText: string, done: boolean): void;
  getCommitmentStatuses(): Record<string, boolean>;
  toJSON(): string;
  loadJSON(json: string): void;
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
