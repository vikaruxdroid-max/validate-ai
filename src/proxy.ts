import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";

const DG_KEY = process.env.VITE_DEEPGRAM_API_KEY;
const PORT = 3001;

if (!DG_KEY) {
  console.error("[proxy] VITE_DEEPGRAM_API_KEY not set in .env");
  process.exit(1);
}

console.log("[proxy] key length:", DG_KEY.length, "first 8:", DG_KEY.slice(0, 8));

const wss = new WebSocketServer({ port: PORT });
console.log(`[proxy] listening on ws://localhost:${PORT}`);

wss.on("connection", (browser) => {
  console.log("[proxy] browser connected, opening Deepgram upstream");

  const dgUrl =
    "wss://api.deepgram.com/v1/listen" +
    "?encoding=linear16&sample_rate=16000&channels=1" +
    "&punctuate=true&interim_results=true&utterance_end_ms=1500";

  const headers = { Authorization: `Token ${DG_KEY}` };

  console.log("[proxy] URL:", dgUrl);
  console.log("[proxy] headers:", JSON.stringify(headers));

  const dg = new WebSocket(dgUrl, { headers });

  dg.binaryType = "arraybuffer";

  dg.on("open", () => console.log("[proxy] Deepgram OPEN"));

  // Deepgram → browser
  let dgMsgCount = 0;
  dg.on("message", (data, isBinary) => {
    dgMsgCount++;
    if (dgMsgCount <= 10) {
      const str = Buffer.isBuffer(data) ? data.toString() : String(data);
      console.log(`[proxy] DG→browser #${dgMsgCount} isBinary:${isBinary} len:${str.length} preview:${str.slice(0, 200)}`);
    }
    if (browser.readyState === WebSocket.OPEN) {
      browser.send(data, { binary: isBinary });
    }
  });

  // Browser PCM → Deepgram
  let browserMsgCount = 0;
  browser.on("message", (data, isBinary) => {
    browserMsgCount++;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (browserMsgCount <= 5) {
      const nonZero = buf.some((b) => b !== 0);
      console.log(`[proxy] browser→DG #${browserMsgCount} isBinary:${isBinary} len:${buf.length} nonZero:${nonZero} first8:[${Array.from(buf.slice(0, 8))}]`);
    }
    if (browserMsgCount === 100) {
      console.log("[proxy] 100 audio chunks forwarded, suppressing further logs");
    }
    if (dg.readyState === WebSocket.OPEN) {
      dg.send(buf);
    }
  });

  dg.on("close", (code, reason) => {
    console.log("[proxy] Deepgram CLOSE — code:", code, "reason:", reason.toString());
    if (browser.readyState === WebSocket.OPEN) browser.close();
  });

  dg.on("error", (err) => {
    console.error("[proxy] Deepgram ERROR:", err.message);
  });

  dg.on("unexpected-response", (_req, res) => {
    let body = "";
    res.on("data", (chunk: Buffer) => (body += chunk.toString()));
    res.on("end", () => {
      console.error("[proxy] Deepgram HTTP", res.statusCode, "—", body);
    });
  });

  browser.on("close", () => {
    console.log("[proxy] browser disconnected");
    if (dg.readyState === WebSocket.OPEN) dg.close();
  });

  browser.on("error", (err) => {
    console.error("[proxy] browser ERROR:", err.message);
  });
});
