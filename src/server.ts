import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config, clock } from "./config.js";
import { q } from "./db.js";
import { runTurn, type AgentEvent } from "./agent.js";
import { hasLlm } from "./llm.js";
import { hasSearch } from "./search.js";
import { seedDemo, isEmpty } from "./seed.js";

/** Plain node:http: three JSON routes, one streaming route, one static page. */
const page = () => readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 50_000) throw new Error("too large"); }
  return JSON.parse(raw || "{}");
}
const json = (res: ServerResponse, code: number, data: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };

export function start() {
  if (isEmpty()) console.log(`Seeded ${seedDemo()} demo conversations (backdated) for testing memory.`);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page()); }
      if (req.method === "GET" && url.pathname === "/api/status")
        return json(res, 200, { llm: hasLlm(), search: hasSearch(), now: clock.now().toISOString() });
      if (req.method === "GET" && url.pathname === "/api/conversations") return json(res, 200, q.conversations());
      if (req.method === "GET" && url.pathname.startsWith("/api/conversations/")) {
        const turns = q.conversation(decodeURIComponent(url.pathname.split("/").pop()!));
        return json(res, 200, turns.map((t) => ({ ...t, sources: t.role === "assistant" ? q.sourcesFor(t.id) : [] })));
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
    if (!hasLlm()) console.log("  ! No LLM key: add GEMINI_API_KEY or GROQ_API_KEY to .env");
    if (!hasSearch()) console.log("  ! No search key: add TAVILY_API_KEY (or EXA_API_KEY) to .env");
  });
  return server;
}
