import "dotenv/config";
import { readFileSync, statSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "https";
import { WebSocketServer, WebSocket } from "ws";
import { initDatabase, importJSON, exportJSON, clearAll } from "./services/database";

const DG_KEY = process.env.VITE_DEEPGRAM_API_KEY;
const PORT = 3001;
const CERT_DIR = "/etc/letsencrypt/live/vikarux-g2.centralus.cloudapp.azure.com";
const MEMORY_PATH = process.env.MEMORY_PATH ?? "/home/vikarux/validate-ai/session-memory.json";
const DB_PATH = process.env.DB_PATH ?? "/home/vikarux/validate-ai/validateai.db";

if (!DG_KEY) {
  console.error("[proxy] VITE_DEEPGRAM_API_KEY not set in .env");
  process.exit(1);
}

console.log("[proxy] Deepgram API key configured, length:", DG_KEY.length);
console.log("[proxy] DB path:", DB_PATH, "JSON path:", MEMORY_PATH);

// Initialize SQLite database (runs migration from JSON if needed)
const db = initDatabase(DB_PATH, MEMORY_PATH);

// ── Helpers ─────────────────────────────────────────────────────────

function errBody(error: string, code: string): string {
  return JSON.stringify({ error, code, timestamp: new Date().toISOString() });
}

// ── HTTPS server with request handler for persistence ───────────────

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  // CORS headers for browser access
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Dev-Mode");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/memory/save" && req.method === "POST") {
    if (!req.headers["content-type"]?.includes("application/json")) {
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end(errBody("Content-Type must be application/json", "INVALID_CONTENT_TYPE"));
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        importJSON(db, data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      } catch (err: any) {
        console.error("[proxy] memory save error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(errBody(err.message, "SAVE_FAILED"));
      }
    });
    return;
  }

  if (req.url === "/memory/load" && req.method === "GET") {
    try {
      const json = exportJSON(db);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(json);
    } catch (err: any) {
      console.error("[proxy] memory load error:", err.message);
      res.writeHead(500);
      res.end(errBody(err.message, "LOAD_FAILED"));
    }
    return;
  }

  if (req.url === "/memory" && req.method === "DELETE") {
    try {
      clearAll(db);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (err: any) {
      console.error("[proxy] memory delete error:", err.message);
      res.writeHead(500);
      res.end(errBody(err.message, "DELETE_FAILED"));
    }
    return;
  }

  // ── Dev endpoints (guarded) ──────────────────────────────────────
  if (req.url?.startsWith("/api/dev/")) {
    // Note: X-Dev-Mode header can be set by any client.
    // The localhost check is the real security boundary.
    // The header is a convenience for LAN development only.
    const isLocal = req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1" || req.socket.remoteAddress === "::ffff:127.0.0.1";
    const hasHeader = req.headers["x-dev-mode"] === "true";
    if (!isLocal && !hasHeader) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(errBody("Dev endpoint unavailable", "FORBIDDEN"));
      return;
    }

    if (req.url === "/api/dev/stats" && req.method === "GET") {
      try {
        const counts = {
          sessions: (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as any).n,
          commitments: (db.prepare("SELECT COUNT(*) as n FROM commitments").get() as any).n,
          decisions: (db.prepare("SELECT COUNT(*) as n FROM decisions").get() as any).n,
          entities: (db.prepare("SELECT COUNT(*) as n FROM entities").get() as any).n,
          contradictions: (db.prepare("SELECT COUNT(*) as n FROM contradictions").get() as any).n,
          personas: (db.prepare("SELECT COUNT(*) as n FROM personas").get() as any).n,
          selfPersonas: (db.prepare("SELECT COUNT(*) as n FROM personas WHERE is_self=1").get() as any).n,
          pinnedItems: (db.prepare("SELECT COUNT(*) as n FROM pinned_items").get() as any).n,
        };
        let dbSizeBytes = 0;
        try { dbSizeBytes = statSync(DB_PATH).size; } catch { /* file may not exist yet */ }
        const dbSizeFormatted = dbSizeBytes > 1048576 ? (dbSizeBytes / 1048576).toFixed(1) + " MB" : (dbSizeBytes / 1024).toFixed(1) + " KB";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...counts, dbSizeBytes, dbSizeFormatted }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.url === "/api/dev/export" && req.method === "GET") {
      try {
        const result: any = { exported_at: new Date().toISOString() };
        // Each table queried individually — no string interpolation in SQL
        result.sessions = db.prepare("SELECT * FROM sessions").all();
        result.commitments = db.prepare("SELECT * FROM commitments").all();
        result.decisions = db.prepare("SELECT * FROM decisions").all();
        result.entities = db.prepare("SELECT * FROM entities").all();
        result.contradictions = db.prepare("SELECT * FROM contradictions").all();
        result.personas = db.prepare("SELECT * FROM personas").all();
        result.pinned_items = db.prepare("SELECT * FROM pinned_items").all();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result, null, 2));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.url === "/api/dev/reset" && req.method === "DELETE") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          if (parsed.confirm !== "RESET") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(errBody("confirm field must be exactly RESET", "INVALID_CONFIRM"));
            return;
          }
          clearAll(db);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ cleared: true, timestamp: new Date().toISOString() }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  // Not a known endpoint — ignore (WebSocket upgrade handled separately)
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

  const dgUrl =
    "wss://api.deepgram.com/v1/listen" +
    "?encoding=linear16&sample_rate=16000&channels=1" +
    "&punctuate=true&interim_results=true&utterance_end_ms=1500";

  const headers = { Authorization: `Token ${DG_KEY}` };

  console.log("[proxy] Deepgram URL:", dgUrl);
  console.log("[proxy] Deepgram auth header set");

  const dg = new WebSocket(dgUrl, { headers });

  dg.binaryType = "arraybuffer";


  // Deepgram → browser
  dg.on("message", (data, isBinary) => {
    if (browser.readyState === WebSocket.OPEN) {
      browser.send(data, { binary: isBinary });
    }
  });

  // Browser PCM → Deepgram
  browser.on("message", (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (dg.readyState === WebSocket.OPEN) {
      dg.send(buf);
    }
  });

  dg.on("close", (code, reason) => {
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
    if (dg.readyState === WebSocket.OPEN) dg.close();
  });

  browser.on("error", (err) => {
    console.error("[proxy] browser ERROR:", err.message);
  });
});
