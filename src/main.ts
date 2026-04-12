import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
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
import type { HudPayload, Verdict } from "./models/types";

// ── Config ──────────────────────────────────────────────────────────
const DISPLAY_W = 576;
const DISPLAY_H = 288;

// ── Container ───────────────────────────────────────────────────────
const ID_MAIN = 1;

// ── State ───────────────────────────────────────────────────────────
let bridge: EvenAppBridge;
let dgSocket: WebSocket | null = null;
let dgReady = false;
const dgPendingBuffer: Uint8Array[] = [];

// ── Display ─────────────────────────────────────────────────────────

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
        content: "LISTENING...",
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

// ── HUD rendering (maps HudPayload → display text) ─────────────────

function renderHud(payload: HudPayload): void {
  if (payload.mode === "LISTENING") {
    updateText("LISTENING...");
    return;
  }

  if (payload.verdict && payload.verdict in VERDICT_ICON) {
    // Fact-validation result — same format as before
    const icon = VERDICT_ICON[payload.verdict as Verdict];
    const header = `${icon} ${payload.verdict} - ${payload.confidence}`;
    const body = wordWrap(payload.line1, 50);
    updateText(header + "\n\n" + body);
    return;
  }

  if (payload.title === "CHECKING") {
    updateText("CHECKING...");
    return;
  }

  if (payload.mode === "ALERT") {
    // Full card for contradictions and errors — 8 seconds
    const header = payload.title ?? "ALERT";
    const body = wordWrap(payload.line1.slice(0, 160), 50);
    updateText(`! ${header}\n\n${body}`);
    return;
  }

  if (payload.mode === "PASSIVE") {
    // Small one-line cue — 4 seconds, no disruption
    const tag = payload.title ?? payload.sourceAnalyzer;
    updateText(`${tag}: ${payload.line1.slice(0, 80)}`);
    return;
  }

  if (payload.mode === "CARD") {
    // Generic card for non-verdict results (recall, etc.)
    const header = payload.title ?? "INFO";
    const conf = payload.confidence ? ` - ${payload.confidence}` : "";
    const body = wordWrap(payload.line1, 50);
    updateText(`${header}${conf}\n\n${body}`);
    return;
  }

  // Fallback
  updateText(payload.line1.slice(0, 120));
}

// ── Deepgram (via proxy) ────────────────────────────────────────────

let orchestrator: Orchestrator;

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

  // Initialize orchestrator with HUD callback
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
  orchestrator.start();

  const micOk = await bridge.audioControl(true);
  console.log("[ValidateAI] mic:", micOk);

  connectDeepgram();

  bridge.onEvenHubEvent((event) => {
    if (event.audioEvent?.audioPcm) {
      sendAudio(event.audioEvent.audioPcm);
    }
  });

  console.log("[ValidateAI] ready");
}

main().catch((err) => console.error("[ValidateAI] fatal:", err));
