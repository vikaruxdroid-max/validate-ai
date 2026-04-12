import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";

// ── Config ──────────────────────────────────────────────────────────
const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY as string;
const DISPLAY_W = 576;
const DISPLAY_H = 288;
const BUFFER_SECONDS = 90;
const COOLDOWN_MS = 30_000;
const RESULT_DISPLAY_MS = 10_000;

// ── Types ───────────────────────────────────────────────────────────
type Verdict = "SUPPORTED" | "PARTIAL" | "DISPUTED";
type Confidence = "HIGH" | "MED" | "LOW";

interface ValidationResult {
  verdict: Verdict;
  summary: string;
  confidence: Confidence;
}

interface Segment {
  text: string;
  ts: number;
}

// ── Container ───────────────────────────────────────────────────────
const ID_MAIN = 1;

// ── State ───────────────────────────────────────────────────────────
let bridge: EvenAppBridge;
let dgSocket: WebSocket | null = null;
let dgReady = false;
const dgPendingBuffer: Uint8Array[] = [];
const transcript: Segment[] = [];
let cooldownUntil = 0;

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

async function showListening(): Promise<void> {
  await updateText("LISTENING...");
}

async function showChecking(): Promise<void> {
  await updateText("CHECKING...");
}

async function showResult(r: ValidationResult): Promise<void> {
  const header = `${VERDICT_ICON[r.verdict]} ${r.verdict} - ${r.confidence}`;
  const body = wordWrap(r.summary, 50);
  await updateText(header + "\n\n" + body);
}

async function showError(msg: string): Promise<void> {
  await updateText("ERROR\n\n" + msg.slice(0, 160));
}

// ── Deepgram (via proxy) ────────────────────────────────────────────

function connectDeepgram(): void {
  dgSocket = new WebSocket("ws://localhost:3001");
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
      const text: string | undefined =
        data?.channel?.alternatives?.[0]?.transcript;
      if (text && text.trim()) handleTranscript(text.trim());
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

// ── Transcript & trigger ────────────────────────────────────────────

const TRIGGERS = [
  // Primary: "even check" + common STT mishearings
  "even check",
  "even czech",
  "even jack",
  "even chek",
  // Alternatives
  "fact check",
  "check this",
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z ]/g, "").replace(/ +/g, " ").trim();
}

function detectTrigger(text: string): string | null {
  const clean = normalize(text);
  for (const t of TRIGGERS) {
    if (clean.includes(t)) return t;
  }
  return null;
}

function handleTranscript(text: string): void {
  const now = Date.now();
  transcript.push({ text, ts: now });
  console.log("[STT]", text);

  // Prune segments older than 90s
  const cutoff = now - BUFFER_SECONDS * 1000;
  while (transcript.length > 0 && transcript[0].ts < cutoff) {
    transcript.shift();
  }

  if (now < cooldownUntil) return;

  const matched = detectTrigger(text);
  if (matched) {
    console.log("[Trigger] matched:", matched, "in:", text);
    runValidation();
  }
}

function getRecentTranscript(): string {
  return transcript.map((s) => s.text).join(" ");
}

// ── Validation pipeline ─────────────────────────────────────────────

async function runValidation(): Promise<void> {
  cooldownUntil = Date.now() + COOLDOWN_MS;
  await showChecking();

  const recentText = getRecentTranscript();
  if (recentText.trim().length < 10) {
    await showError("Not enough speech to validate");
    setTimeout(() => showListening(), 5000);
    return;
  }

  try {
    // Step 1: Extract claim via Haiku
    console.log("[Validate] extracting claim...");
    const claim = await extractClaim(recentText);
    if (!claim || claim === "NONE") {
      await showError("No verifiable claim found");
      setTimeout(() => showListening(), 5000);
      return;
    }
    console.log("[Validate] claim:", claim);

    // Step 2: Validate via Sonnet + web search
    console.log("[Validate] checking claim...");
    const result = await validateClaim(claim);
    console.log("[Validate] result:", JSON.stringify(result));
    await showResult(result);

    setTimeout(() => showListening(), RESULT_DISPLAY_MS);
  } catch (err: any) {
    console.error("[Validate] error:", err);
    await showError(err?.message ?? "Validation failed");
    setTimeout(() => showListening(), 5000);
  }
}

// ── Claude API calls ────────────────────────────────────────────────

async function claudeRequest(
  model: string,
  system: string,
  userMsg: string,
  tools?: any[],
  maxTokens = 256
): Promise<string> {
  const body: any = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userMsg }],
  };
  if (tools) body.tools = tools;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude ${res.status}: ${errBody}`);
  }

  const json = await res.json();
  const textBlock = json.content?.find((b: any) => b.type === "text");
  if (!textBlock?.text) throw new Error("No text in Claude response");
  return textBlock.text;
}

async function extractClaim(recentText: string): Promise<string | null> {
  const system =
    "You are a fact-checking assistant. From this conversation transcript, " +
    "identify the single most recent verifiable factual claim that could be " +
    "true or false. Return ONLY the claim as a plain sentence. " +
    "If no verifiable claim exists, return NONE.";

  const text = await claudeRequest(
    "claude-haiku-4-5-20251001",
    system,
    recentText,
    undefined,
    128
  );
  const trimmed = text.trim();
  return trimmed || null;
}

async function validateClaim(claim: string): Promise<ValidationResult> {
  const system =
    "You are a fact-checking assistant. Use web search to verify the claim " +
    "against multiple sources. Respond with ONLY valid JSON:\n" +
    '{"verdict":"SUPPORTED"|"PARTIAL"|"DISPUTED",' +
    '"summary":"<one line, max 80 chars>",' +
    '"confidence":"HIGH"|"MED"|"LOW"}\n' +
    "SUPPORTED = well-supported by reliable sources\n" +
    "PARTIAL = partly true but missing context\n" +
    "DISPUTED = contradicted by reliable sources\n" +
    "No text outside the JSON.";

  const text = await claudeRequest(
    "claude-sonnet-4-20250514",
    system,
    `Fact-check: "${claim}"`,
    [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    256
  );

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in validation response");

  const parsed = JSON.parse(match[0]);
  return {
    verdict: parsed.verdict ?? "DISPUTED",
    summary: parsed.summary ?? "Unable to determine",
    confidence: parsed.confidence ?? "LOW",
  };
}

// ── Bootstrap ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[ValidateAI] starting");

  bridge = await waitForEvenAppBridge();
  console.log("[ValidateAI] bridge ready");

  await initDisplay();

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
