import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { config, clock } from "./config.js";
import { q } from "./db.js";
import { runTurn, type AgentEvent } from "./agent.js";
import { hasLlm, testLlm } from "./llm.js";
import { hasSearch, testSearch } from "./search.js";
import * as settings from "./settings.js";
import { seedDemo, isEmpty } from "./seed.js";

/** Plain node:http: JSON routes, one streaming route, the page and its static assets. */
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const page = () => readFileSync(join(PUBLIC, "index.html"), "utf8");
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
function asset(pathname: string, res: ServerResponse) {
  const file = normalize(join(PUBLIC, decodeURIComponent(pathname)));
  const type = TYPES[extname(file)];
  if (!file.startsWith(join(PUBLIC, "assets")) || !type || !existsSync(file)) return false; // no traversal, known types only
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  res.end(readFileSync(file));
  return true;
}

async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 50_000) throw new Error("too large"); }
  return JSON.parse(raw || "{}");
}
const json = (res: ServerResponse, code: number, data: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };

const loopback = (req: IncomingMessage) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
/** A browser always sends Origin on cross-site POSTs; when present it must match the Host we were reached on. */
function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl, scripts, the eval runner
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

/**
 * Memory graph: conversations and the topics (entities) they touched. Topics are merged
 * case-insensitively; a topic shared by two chats links them. Days are added by the client
 * (it knows the user's timezone).
 */
function graph() {
  const convs = q.conversations();
  const ids = new Set(convs.map((c) => c.conversation_id));
  const topics = new Map<string, { label: string; chats: Set<string> }>();
  for (const { c, e } of q.graphPairs()) {
    const label = String(e).trim();
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!ids.has(c) || !key || key.length > 40) continue;
    if (!topics.has(key)) topics.set(key, { label, chats: new Set() });
    topics.get(key)!.chats.add(c);
  }
  return {
    chats: convs.map((c) => ({ id: c.conversation_id, label: c.title, started: c.started })),
    topics: [...topics.entries()].map(([key, t]) => ({ id: `t:${key}`, label: t.label, chats: [...t.chats] })),
  };
}

export function start() {
  if (isEmpty()) console.log(`Seeded ${seedDemo()} demo conversations (backdated) for testing memory.`);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page()); }
      if (req.method === "GET" && url.pathname.startsWith("/assets/") && asset(url.pathname, res)) return;
      if (req.method === "GET" && url.pathname === "/api/status")
        return json(res, 200, { llm: hasLlm(), search: hasSearch(), now: clock.now().toISOString() });
      if (req.method === "GET" && url.pathname === "/api/conversations") return json(res, 200, q.conversations());
      if (req.method === "GET" && url.pathname === "/api/graph") return json(res, 200, graph());
      if (req.method === "GET" && url.pathname.startsWith("/api/conversations/")) {
        const turns = q.conversation(decodeURIComponent(url.pathname.split("/").pop()!));
        return json(res, 200, turns.map((t) => ({ ...t, sources: t.role === "assistant" ? q.sourcesFor(t.id) : [] })));
      }
      // Every write must come from this machine and this page: blocks other websites (CSRF) and the LAN.
      if (req.method === "POST" && !sameOrigin(req)) return json(res, 403, { error: "forbidden" });
      if (url.pathname === "/api/settings" && req.method === "GET") {
        if (!loopback(req)) return json(res, 403, { error: "settings are only available on this machine" });
        return json(res, 200, settings.view());
      }
      if (url.pathname === "/api/settings" && req.method === "POST") {
        if (!loopback(req)) return json(res, 403, { error: "settings are only available on this machine" });
        try { return json(res, 200, settings.update(await body(req))); } catch (e) { return json(res, 400, { error: (e as Error).message }); }
      }
      if (url.pathname === "/api/settings/test" && req.method === "POST") {
        if (!loopback(req)) return json(res, 403, { error: "forbidden" });
        const { provider } = await body(req);
        try {
          if ((settings.LLMS as readonly string[]).includes(provider)) return json(res, 200, await testLlm(provider));
          if ((settings.SEARCHES as readonly string[]).includes(provider)) return json(res, 200, await testSearch(provider));
          return json(res, 400, { ok: false, error: "unknown provider" });
        } catch (e) { return json(res, 200, { ok: false, error: String((e as Error).message).slice(0, 300) }); }
      }
      if (req.method === "POST" && url.pathname === "/api/seed") {
        const b = await body(req);
        return json(res, 200, { seeded: seedDemo(undefined, Number(b.tzOffset ?? new Date().getTimezoneOffset())) });
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const b = await body(req);
        const message = String(b.message ?? "").trim().slice(0, 4000);
        if (!message) return json(res, 400, { error: "message required" });
        const conversationId = typeof b.conversationId === "string" && b.conversationId ? b.conversationId : randomUUID();
        const tzOffset = Number.isFinite(b.tzOffset) ? Number(b.tzOffset) : 0;
        // Newline-delimited JSON events: simple to stream and to parse in the browser.
        res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache", "x-conversation-id": conversationId });
        const emit = (e: AgentEvent) => res.write(JSON.stringify(e) + "\n");
        const pending = await runTurn({ conversationId, message, tzOffset }, emit).catch((e) => emit({ type: "error", text: String(e?.message ?? e) }));
        res.end();
        await pending; // fact extraction finishes after the response is closed
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: String((e as Error).message) });
      else res.end();
    }
  });
  server.listen(config.port, () => {
    console.log(`\n  minimi chat → http://localhost:${config.port}`);
    if (!hasLlm()) console.log("  ! No LLM key: add GEMINI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY or DEEPSEEK_API_KEY to .env");
    if (!hasSearch()) console.log("  ! No search key: add TAVILY_API_KEY (or EXA_API_KEY) to .env");
  });
  return server;
}
