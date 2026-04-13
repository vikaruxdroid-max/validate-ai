import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  ListContainerProperty,
  ListItemContainerProperty,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { Orchestrator } from "./orchestrator";
import {
  CommitmentsAnalyzer,
  DecisionsAnalyzer,
  IntentAnalyzer,
  HedgingAnalyzer,
  ContradictionAnalyzer,
  TopicShiftAnalyzer,
  StressCuesAnalyzer,
} from "./analyzers";
import type { HudPayload, Verdict, PersonaBrief, PersonaSignalSnapshot } from "./models/types";
import { claudeRequest } from "./services/claude";

// ── Config ──────────────────────────────────────────────────────────
const DISPLAY_W = 576;
const DISPLAY_H = 288;
const ID_MAIN = 1;
const ID_LIST = 2;

// ── State ───────────────────────────────────────────────────────────
let bridge: EvenAppBridge;
let dgSocket: WebSocket | null = null;
let dgReady = false;
const dgPendingBuffer: Uint8Array[] = [];
let listDismissTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatStep = 0; // 0="L." 1="L.." 2="L..."
let isListening = true;
let orchestrator: Orchestrator;

// ── Display helpers ─────────────────────────────────────────────────

async function updateText(content: string): Promise<void> {
  const upgrade = new TextContainerUpgrade();
  upgrade.containerID = ID_MAIN;
  upgrade.content = content;
  await bridge.textContainerUpgrade(upgrade);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function initDisplay(): Promise<void> {
  const container = {
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        containerID: ID_MAIN,
        xPosition: 0,
        yPosition: 0,
        width: DISPLAY_W,
        height: DISPLAY_H,
        borderWidth: 0,
        borderRadius: 0,
        paddingLength: 4,
        isEventCapture: 1,
        content: "L.",
      }),
    ],
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await bridge.createStartUpPageContainer(container);
    console.log("[Display] attempt", attempt, "result:", result);
    if (result === 0) return;
    await delay(500);
  }
  console.error("[Display] all attempts failed");
}

function wordWrap(text: string, width: number): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? line + " " + w : w;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

const VERDICT_ICON: Record<Verdict, string> = {
  SUPPORTED: "\u2713",
  PARTIAL: "~",
  DISPUTED: "\u2717",
};

const HEARTBEAT_FRAMES = ["L.", "L..", "L..."];

// ── Heartbeat: L. → L.. → L... → L. (600ms per step) ──────────────

function startHeartbeat(): void {
  stopHeartbeat();
  isListening = true;
  heartbeatStep = 0;
  updateText(HEARTBEAT_FRAMES[0]);
  heartbeatTimer = setInterval(() => {
    if (!isListening) return;
    heartbeatStep = (heartbeatStep + 1) % 3;
    updateText(HEARTBEAT_FRAMES[heartbeatStep]);
  }, 600);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  isListening = false;
}

// ── List Container ──────────────────────────────────────────────────

async function showListContainer(items: string[]): Promise<void> {
  stopHeartbeat();
  const listProp = new ListContainerProperty({
    containerID: ID_LIST,
    xPosition: 0,
    yPosition: 0,
    width: DISPLAY_W,
    height: DISPLAY_H,
    borderWidth: 0,
    borderRadius: 0,
    paddingLength: 4,
    isEventCapture: 1,
    containerName: "List",
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length,
      itemWidth: DISPLAY_W,
      itemName: items,
    }),
  });

  await bridge.rebuildPageContainer({
    containerTotalNum: 1,
    listObject: [listProp],
  });
  console.log("[Display] list shown with", items.length, "items");
}

async function restoreTextContainer(): Promise<void> {
  if (listDismissTimer) {
    clearTimeout(listDismissTimer);
    listDismissTimer = null;
  }

  await bridge.rebuildPageContainer({
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        containerID: ID_MAIN,
        xPosition: 0,
        yPosition: 0,
        width: DISPLAY_W,
        height: DISPLAY_H,
        borderWidth: 0,
        borderRadius: 0,
        paddingLength: 4,
        isEventCapture: 1,
        content: "L.",
      }),
    ],
  });
  startHeartbeat();
  console.log("[Display] text container restored");
}

// ── HUD rendering ───────────────────────────────────────────────────

function renderHud(payload: HudPayload): void {
  if (payload.mode === "LISTENING") {
    startHeartbeat();
    return;
  }

  if (payload.mode === "LIST" && payload.listItems) {
    showListContainer(payload.listItems);
    listDismissTimer = setTimeout(() => restoreTextContainer(), payload.ttlMs || 5000);
    return;
  }

  // All other modes: stop heartbeat, show content
  stopHeartbeat();

  if (payload.verdict && payload.verdict in VERDICT_ICON) {
    const icon = VERDICT_ICON[payload.verdict as Verdict];
    const header = `${icon} ${payload.verdict} - ${payload.confidence}`;
    const body = wordWrap(payload.line1, 50);
    updateText(header + "\n\n" + body);
    return;
  }

  if (payload.title === "CHECKING") {
    updateText("C...");
    return;
  }

  if (payload.mode === "ALERT") {
    const header = payload.title ?? "ALERT";
    const now = wordWrap(payload.line1.slice(0, 100), 50);
    const prior = payload.line2 ? "\n" + wordWrap(payload.line2.slice(0, 100), 50) : "";
    updateText(`! ${header}\n\n${now}${prior}`);
    return;
  }

  if (payload.mode === "PASSIVE") {
    const tag = payload.title ?? payload.sourceAnalyzer;
    updateText(`${tag}: ${payload.line1.slice(0, 60)}`);
    return;
  }

  if (payload.mode === "CARD") {
    const header = payload.title ?? "INFO";
    const conf = payload.confidence ? ` - ${payload.confidence}` : "";
    const body = payload.line2 ?? wordWrap(payload.line1, 50);
    updateText(`${header}${conf}\n\n${body}`);
    return;
  }

  updateText(payload.line1.slice(0, 120));
}

// ── Deepgram (via proxy) ────────────────────────────────────────────

function connectDeepgram(): void {
  dgSocket = new WebSocket("wss://vikarux-g2.centralus.cloudapp.azure.com:3001");
  dgSocket.binaryType = "arraybuffer";

  dgSocket.onopen = () => {
    console.log("[DG] open");
    dgReady = true;
    for (const chunk of dgPendingBuffer) dgSocket!.send(chunk);
    dgPendingBuffer.length = 0;
  };

  dgSocket.onmessage = (evt: MessageEvent) => {
    try {
      const data = JSON.parse(evt.data);
      if (!data?.is_final) return;
      const alt = data?.channel?.alternatives?.[0];
      const text: string | undefined = alt?.transcript;
      if (text && text.trim()) {
        const words: any[] | undefined = alt?.words;
        const wordCount = words?.length;
        const confidence: number | undefined = alt?.confidence;
        let durationMs: number | undefined;
        if (words && words.length >= 2) {
          const start = words[0]?.start ?? 0;
          const end = words[words.length - 1]?.end ?? start;
          durationMs = Math.round((end - start) * 1000);
        }
        orchestrator.handleTranscript(text.trim(), { confidence, wordCount, durationMs });
      }
    } catch { /* keepalive */ }
  };

  dgSocket.onclose = () => {
    dgReady = false;
    setTimeout(connectDeepgram, 2000);
  };

  dgSocket.onerror = () => { dgReady = false; };
}

function sendAudio(pcm: Uint8Array): void {
  if (dgReady && dgSocket?.readyState === WebSocket.OPEN) {
    dgSocket.send(pcm);
  } else {
    dgPendingBuffer.push(pcm);
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[ValidateAI] starting");

  bridge = await waitForEvenAppBridge();
  console.log("[ValidateAI] bridge ready");

  await initDisplay();

  orchestrator = new Orchestrator(renderHud);
  orchestrator.registerAnalyzers([
    new CommitmentsAnalyzer(),
    new DecisionsAnalyzer(),
    new IntentAnalyzer(),
    new HedgingAnalyzer(),
    new ContradictionAnalyzer(),
    new TopicShiftAnalyzer(),
    new StressCuesAnalyzer(),
  ]);
  const memoryItemCount = await orchestrator.start();

  // Launch greeting
  if (memoryItemCount > 0) {
    updateText(`WELCOME BACK\n\n${memoryItemCount} items in memory`);
    await delay(3000);
  } else {
    updateText("R");
    await delay(2000);
  }

  startHeartbeat();

  const micOk = await bridge.audioControl(true);
  console.log("[ValidateAI] mic:", micOk);

  connectDeepgram();

  bridge.onEvenHubEvent((event) => {
    if (event.audioEvent?.audioPcm) {
      sendAudio(event.audioEvent.audioPcm);
    }
    if (event.listEvent && listDismissTimer) {
      console.log("[Display] list event received, dismissing list");
      restoreTextContainer();
    }
  });

  // ── Persona brief + post-session helpers ──────────────────────────
  let briefLoadingPid: string | null = null;
  let personaUpdates: Array<{ personaId: string; name: string; changes: string }> = [];

  async function generatePersonaBrief(personaId: string): Promise<void> {
    const store = orchestrator.getMemoryStore();
    const persona = store.getPersonaById(personaId);
    if (!persona) return;
    const sessions = store.getSessions();
    const commitments = store.getCommitments();
    const statuses = store.getCommitmentStatuses();
    const entities = store.getEntities();
    const sids = persona.sessionIds || [];
    const linkedSessions = sessions.filter(s => sids.includes(s.id));
    const linkedCommits = commitments.filter(c => c.sessionId && sids.includes(c.sessionId));
    const linkedEntities = entities.filter(e => e.sessionId && sids.includes(e.sessionId));
    const nameL = persona.name.toLowerCase();
    const relevantCommits = linkedCommits.filter(c =>
      (c.text || "").toLowerCase().includes(nameL) || (c.owner || "").toLowerCase().includes(nameL));
    const openCommits = relevantCommits.filter(c => !statuses[c.text]);
    const lastSession = linkedSessions[0]; // sorted newest first

    const artifactPayload = JSON.stringify({
      persona: { name: persona.name, aliases: persona.aliases, notes: persona.notes, sessionCount: sids.length },
      sessions: linkedSessions.map(s => ({ label: s.label, startedAt: s.startedAt, endedAt: s.endedAt, stats: s.stats })),
      commitments: relevantCommits.map(c => ({ text: c.text, owner: c.owner, dueDate: c.dueDate, done: !!statuses[c.text] })),
      entities: linkedEntities.slice(0, 30).map(e => ({ text: e.text, type: e.type, context: e.context })),
      signalSnapshots: persona.signalSnapshots || [],
    });

    const system = `You analyze conversation artifacts about a person and generate a structured pre-conversation brief. Focus on actionable insights. Be concise. Frame all observations as patterns, never character assessments. Return ONLY valid JSON with fields: who (string), lastInteraction (string), openCommitments (string[]), openQuestions (string[]), signals (string[]), behavioralPatterns (array of {signal, observation, confidence, evidenceCount, caveat}), suggestedFollowUps (string[]), nextSteps (string[]).`;
    try {
      const raw = await claudeRequest("claude-sonnet-4-20250514", system,
        `Person: ${persona.name}\nArtifacts:\n${artifactPayload}`, undefined, 1024);
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const brief: PersonaBrief = { ...JSON.parse(match[0]), generatedAt: Date.now() };
        store.setPersonaBrief(personaId, brief);
        console.log("[Brief] generated for:", persona.name);
      }
    } catch (err) { console.warn("[Brief] generation failed:", err); }
  }

  function computePostSessionUpdates(endedSessionId: string): void {
    const store = orchestrator.getMemoryStore();
    const personas = store.getPersonas();
    const commitments = store.getCommitments();
    const outputs = orchestrator.getRecentOutputs();

    for (const p of personas) {
      if (!p.sessionIds.includes(endedSessionId)) continue;
      // Build signal snapshot
      const sessionCommits = commitments.filter(c => c.sessionId === endedSessionId);
      const nameL = p.name.toLowerCase();
      const relCommits = sessionCommits.filter(c =>
        (c.text || "").toLowerCase().includes(nameL) || (c.owner || "").toLowerCase().includes(nameL));
      const hedgingScores = outputs.filter(o => o.analyzer === "hedging" && o.triggered && o.details?.score != null)
        .map(o => Number(o.details!.score));
      const intentCounts: Record<string, number> = {};
      outputs.filter(o => o.analyzer === "intent" && o.triggered && o.details?.intent)
        .forEach(o => { const k = String(o.details!.intent); intentCounts[k] = (intentCounts[k] || 0) + 1; });
      const topicShifts = outputs.filter(o => o.analyzer === "topicShift" && o.triggered).length;
      const contradictions = outputs.filter(o => o.analyzer === "contradiction" && o.triggered).length;

      const snapshot: PersonaSignalSnapshot = {
        sessionId: endedSessionId, ts: Date.now(), contradictions, hedgingScores, intentCounts, topicShifts,
        commitmentsMade: relCommits.length,
      };
      store.addPersonaSignalSnapshot(p.id, snapshot);

      // Build change summary
      const changes: string[] = [];
      if (relCommits.length) changes.push(`${relCommits.length} new commitment${relCommits.length > 1 ? "s" : ""}`);
      if (contradictions) changes.push(`${contradictions} contradiction${contradictions > 1 ? "s" : ""} detected`);
      if (topicShifts) changes.push(`${topicShifts} topic shift${topicShifts > 1 ? "s" : ""}`);
      if (changes.length) {
        personaUpdates.push({ personaId: p.id, name: p.name, changes: changes.join(", ") });
      }
    }
  }

  // ── Phone companion UI state bridge ──────────────────────────────
  let stateVersion = 0;
  function updatePhoneState(): void {
    const store = orchestrator.getMemoryStore();
    const session = store.getSession();
    const stats = orchestrator.getStats();
    stateVersion++;
    (window as any).validateAIState = {
      version: stateVersion,
      status: isListening ? "LISTENING" : "ACTIVE",
      recentOutputs: orchestrator.getRecentOutputs(),
      commitments: session.commitments,
      decisions: session.decisions,
      entities: session.entities,
      pinned: session.pinned,
      sessions: store.getSessions(),
      activeSessionId: store.getCurrentSessionId(),
      decisionsRaw: store.getDecisionsRaw(),
      stats: {
        factsChecked: stats.factsChecked,
        contradictions: stats.contradictions,
        commitments: session.commitments.length,
        decisions: session.decisions.length,
        entities: session.entities.length,
        sessionStartTs: stats.sessionStartTs,
      },
      activeAnalyzers: orchestrator.getDisabledAnalyzers(),
      analyzerBadge: orchestrator.getAnalyzerBadge(),
      personas: store.getPersonas(),
      pendingPersonaDetection: orchestrator.getPendingPersonaDetection(),
      commitmentStatuses: store.getCommitmentStatuses(),
      briefLoadingPid,
      personaUpdates,
    };
  }
  updatePhoneState();
  setInterval(updatePhoneState, 250);

  // ── HUD watchdog: force L. if stuck past 6 seconds ────────────────
  let lastHudChangeTs = Date.now();
  const originalRenderHud = renderHud;
  renderHud = function watchdogRenderHud(payload: HudPayload) {
    lastHudChangeTs = Date.now();
    originalRenderHud(payload);
  };
  setInterval(() => {
    if (!isListening && Date.now() - lastHudChangeTs > 6000) {
      console.warn("[Watchdog] HUD stuck, forcing L.");
      startHeartbeat();
      lastHudChangeTs = Date.now();
    }
  }, 3000);

  // Listen for trigger events from phone UI
  window.addEventListener("validateai-trigger", ((e: CustomEvent) => {
    const phrase = e.detail?.phrase;
    if (phrase) {
      console.log("[PhoneUI] trigger received:", phrase);
      orchestrator.handleTranscript(phrase);
    }
  }) as EventListener);

  // Listen for session management events from phone UI
  window.addEventListener("validateai-session", ((e: CustomEvent) => {
    const action = e.detail?.action;
    const store = orchestrator.getMemoryStore();
    if (action === "START") {
      const id = store.startSession();
      console.log("[PhoneUI] session started:", id);
    } else if (action === "END") {
      const activeId = store.getCurrentSessionId();
      const stats = orchestrator.getStats();
      store.endSession(stats.factsChecked, stats.contradictions);
      if (activeId) computePostSessionUpdates(activeId);
      store.save();
      console.log("[PhoneUI] session ended and saved");
    }
    updatePhoneState();
  }) as EventListener);

  // Listen for persona events from phone UI
  window.addEventListener("validateai-persona", ((e: CustomEvent) => {
    const { action, name, sessionId, personaId, updates } = e.detail || {};
    const store = orchestrator.getMemoryStore();
    if (action === "CREATE") {
      const persona = store.createPersona(name, sessionId);
      if (sessionId) store.linkArtifactToPersona(persona.id, sessionId);
      orchestrator.clearPendingPersonaDetection();
      console.log("[PhoneUI] persona created:", name);
    } else if (action === "SKIP") {
      orchestrator.clearPendingPersonaDetection();
      console.log("[PhoneUI] persona detection skipped");
    } else if (action === "BRIEF") {
      briefLoadingPid = personaId;
      updatePhoneState();
      generatePersonaBrief(personaId).finally(() => { briefLoadingPid = null; updatePhoneState(); });
      return; // avoid double updatePhoneState
    } else if (action === "UPDATE") {
      if (personaId && updates) store.updatePersona(personaId, updates);
      store.save();
      console.log("[PhoneUI] persona updated:", personaId);
    } else if (action === "TOGGLE_COMMITMENT") {
      const { commitmentText, done } = e.detail;
      store.setCommitmentStatus(commitmentText, done);
      store.save();
    } else if (action === "DISMISS_UPDATES") {
      personaUpdates = [];
    }
    updatePhoneState();
  }) as EventListener);

  console.log("[ValidateAI] ready");
}

main().catch((err) => console.error("[ValidateAI] fatal:", err));
