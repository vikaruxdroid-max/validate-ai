import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "https";
import { WebSocketServer, WebSocket } from "ws";

const DG_KEY = process.env.VITE_DEEPGRAM_API_KEY;
const PORT = 3001;
const CERT_DIR = "/etc/letsencrypt/live/vikarux-g2.centralus.cloudapp.azure.com";
const MEMORY_PATH = process.env.MEMORY_PATH ?? "/home/vikarux/validate-ai/session-memory.json";

if (!DG_KEY) {
  console.error("[proxy] VITE_DEEPGRAM_API_KEY not set in .env");
  process.exit(1);
}

console.log("[proxy] key length:", DG_KEY.length, "first 8:", DG_KEY.slice(0, 8));
console.log("[proxy] memory path:", MEMORY_PATH);

// ── HTTPS server with request handler for persistence ───────────────

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  // CORS headers for browser access
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/memory/save" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      try {
        writeFileSync(MEMORY_PATH, body, "utf-8");
        console.log("[proxy] memory saved:", body.length, "bytes");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      } catch (err: any) {
        console.error("[proxy] memory save error:", err.message);
        res.writeHead(500);
        res.end('{"error":"save failed"}');
      }
    });
    return;
  }

  if (req.url === "/memory/load" && req.method === "GET") {
    try {
      if (existsSync(MEMORY_PATH)) {
        const data = readFileSync(MEMORY_PATH, "utf-8");
        console.log("[proxy] memory loaded:", data.length, "bytes");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(data);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }
    } catch (err: any) {
      console.error("[proxy] memory load error:", err.message);
      res.writeHead(500);
      res.end('{"error":"load failed"}');
    }
    return;
  }

  if (req.url === "/memory" && req.method === "DELETE") {
    try {
      if (existsSync(MEMORY_PATH)) {
        unlinkSync(MEMORY_PATH);
        console.log("[proxy] memory file deleted");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (err: any) {
      console.error("[proxy] memory delete error:", err.message);
      res.writeHead(500);
      res.end('{"error":"delete failed"}');
    }
    return;
  }

  // Not a memory endpoint — ignore (WebSocket upgrade handled separately)
  res.writeHead(404);
  res.end();
}

const httpsServer = createServer(
  {
    cert: readFileSync(`${CERT_DIR}/fullchain.pem`),
    key: readFileSync(`${CERT_DIR}/privkey.pem`),
  },
  handleRequest,
);

const wss = new WebSocketServer({ server: httpsServer });

httpsServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[proxy] listening on wss://0.0.0.0:${PORT}`);
});

// ── Deepgram WebSocket relay ────────────────────────────────────────

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
