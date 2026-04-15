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

const RECONNECT_DELAYS = [2000, 4000, 8000, 16000, 60000];
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(): void {
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(connectDeepgram, delay);
}

function connectDeepgram(): void {
  dgSocket = new WebSocket("wss://vikarux-g2.centralus.cloudapp.azure.com:3001");
  dgSocket.binaryType = "arraybuffer";

  dgSocket.onopen = () => {
    reconnectAttempt = 0; // Reset backoff on successful connection
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
    scheduleReconnect();
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

  connectDeepgram();

  bridge.onEvenHubEvent((event) => {
    if (event.audioEvent?.audioPcm) {
      sendAudio(event.audioEvent.audioPcm);
    }
    if (event.listEvent && listDismissTimer) {
      restoreTextContainer();
    }
  });

  // ── Persona brief + post-session helpers ──────────────────────────
  let briefLoadingPid: string | null = null;
  let personaUpdates: Array<{ personaId: string; name: string; changes: string }> = [];

  async function generatePersonaBrief(personaId: string): Promise<void> {
    const PROXY_BASE = "https://vikarux-g2.centralus.cloudapp.azure.com:3001";
    const briefUrl = `${PROXY_BASE}/api/persona/${encodeURIComponent(personaId)}/brief`;
    const store = orchestrator.getMemoryStore();

    try {
      await fetch(briefUrl, { method: "POST", headers: { "Content-Type": "application/json" } });
    } catch (err) {
      console.warn("[Brief] POST failed:", err);
      return;
    }

    // Poll GET every 3s, max 40 polls (2 min). Server writes brief_json
    // when Claude returns; we surface it to the in-memory store so the UI
    // updates without waiting for the next /memory/load.
    for (let i = 0; i < 40; i++) {
      await new Promise<void>((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(briefUrl);
        if (!res.ok) continue;
        const body = await res.json();
        if (body && body.data != null) {
          store.setPersonaBrief(personaId, body.data as PersonaBrief);
          updatePhoneState();
          return;
        }
        if (body && body.failed) {
          console.warn("[Brief] server reported failure:", body.error);
          return;
        }
      } catch {
        // keep polling on transient errors
      }
    }
    console.warn("[Brief] polling timeout — no result after 2 minutes");
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
      const allNames = [p.name, ...(p.aliases || [])].map(n => n.toLowerCase());
      const matchesName = (text: string) => allNames.some(n => text.toLowerCase().includes(n));
      const relCommits = sessionCommits.filter(c =>
        matchesName(c.text || "") || matchesName(c.owner || ""));
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
      selfPersonaId: orchestrator.getSelfPersonaId(),
      selfPersonaName: orchestrator.getSelfPersonaName(),
    };
  }
  updatePhoneState();
  const statePollingTimer = setInterval(updatePhoneState, 250);

  // ── HUD watchdog: force L. if stuck past 6 seconds ────────────────
  let lastHudChangeTs = Date.now();
  const originalRenderHud = renderHud;
  renderHud = function watchdogRenderHud(payload: HudPayload) {
    lastHudChangeTs = Date.now();
    originalRenderHud(payload);
  };
  const watchdogTimer = setInterval(() => {
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
      orchestrator.handleTranscript(phrase);
    }
  }) as EventListener);

  // Listen for session management events from phone UI
  window.addEventListener("validateai-session", ((e: CustomEvent) => {
    const action = e.detail?.action;
    const store = orchestrator.getMemoryStore();
    if (action === "START") {
      const id = store.startSession();
      orchestrator.resetSelfDetection();
    } else if (action === "END") {
      const activeId = store.getCurrentSessionId();
      const stats = orchestrator.getStats();
      store.endSession(stats.factsChecked, stats.contradictions);
      if (activeId) computePostSessionUpdates(activeId);
      orchestrator.clearSelfPersona();
      store.save();
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
      store.retroactiveLinkPersona(persona.id);
      orchestrator.clearPendingPersonaDetection();
    } else if (action === "SKIP") {
      orchestrator.clearPendingPersonaDetection();
    } else if (action === "BRIEF") {
      briefLoadingPid = personaId;
      updatePhoneState();
      generatePersonaBrief(personaId).finally(() => { briefLoadingPid = null; updatePhoneState(); });
      return; // avoid double updatePhoneState
    } else if (action === "UPDATE") {
      if (personaId && updates) store.updatePersona(personaId, updates);
      store.save();
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
