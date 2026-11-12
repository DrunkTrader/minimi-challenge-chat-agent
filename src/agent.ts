import { clock } from "./config.js";
import { addTurn, addSources, addClaims, setTurnEntities, type Turn } from "./db.js";
import { resolveDate, formatLocal } from "./dates.js";
import { recall, memoryContext, memoryEntities, refersToPast } from "./memory.js";
import { chatJson, chatStream, hasLlm, type Msg } from "./llm.js";
import { searchAll, hasSearch, type SearchResult } from "./search.js";

/**
 * One turn:  dates (code) → memory (SQL) → plan (fast LLM) → web_search (parallel)
 *            → streamed answer (strong LLM) → facts extracted into memory (async).
 */
export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "memory"; range: string | null; hits: { when: string; question: string }[] }
  | { type: "sources"; sources: { n: number; title: string; url: string; published_at: string | null }[] }
  | { type: "token"; text: string }
  | { type: "done"; turnId: number; timings: Record<string, number>; models: string[]; searched: boolean }
  | { type: "error"; text: string };

type Plan = { intent: "chat" | "search" | "recall" | "recheck"; needs_search: boolean; queries: string[]; recent_days: number | null; entities: string[] };
const SMALL_TALK = /^\s*(hi|hello|hey|yo|thanks|thank you|thx|ok(ay)?|cool|nice|great|good (morning|evening|night)|bye)\b[\s!.?]*$/i;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

async function plan(message: string, recent: Turn[], memLines: string, today: string): Promise<{ plan: Plan; model: string }> {
  const system = `You plan one turn for a chat agent whose ONLY tool is web_search. Reply with JSON only:
{"intent":"chat|search|recall|recheck","needs_search":true|false,"queries":["..."],"recent_days":null,"entities":["..."]}
- chat: greetings, thanks, writing/maths/opinion, or fully answered by the conversation → needs_search false.
- search: anything factual that may have changed: prices, news, releases, versions, "best X", comparisons, people, events → needs_search true.
- recall: the user only asks what they asked/said before → needs_search false.
- recheck: the user asks whether a past answer is still correct, or what changed since → needs_search true, one query per entity from MEMORY (max 4), e.g. "Neon Postgres pricing".
- queries: 1-4 short standalone keyword queries (resolve pronouns using the conversation). Add the year only when recency matters.
- recent_days: 7 or 30 only for "news/launches in the last week/month"; otherwise null.
- entities: products/companies/people this turn is about.
Today is ${today}.`;
  const convo = recent.slice(-4).map((t) => `${t.role}: ${clip(t.content, 300)}`).join("\n");
  const user = `${convo ? `CONVERSATION:\n${convo}\n\n` : ""}${memLines ? `MEMORY:\n${memLines}\n\n` : ""}MESSAGE: ${message}`;
  const { data, model } = await chatJson<Plan>("fast", [{ role: "system", content: system }, { role: "user", content: user }], 1000);
  return {
    model,
    plan: {
      intent: data.intent ?? "search",
      needs_search: Boolean(data.needs_search),
      queries: (Array.isArray(data.queries) ? data.queries : []).filter((x) => typeof x === "string" && x.trim()).slice(0, 4),
      recent_days: typeof data.recent_days === "number" ? data.recent_days : null,
      entities: (Array.isArray(data.entities) ? data.entities : []).filter((x) => typeof x === "string").slice(0, 8),
    },
  };
}

function answerSystem(nowLocal: string, tzOffset: number) {
  const sign = tzOffset <= 0 ? "+" : "-", abs = Math.abs(tzOffset);
  return `You are minimi chat: a fast, accurate assistant with web search and a timestamped memory of past conversations.
Now: ${nowLocal} (user's local time, UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}).
Rules:
- Lead with the answer. Be concise. Use a small markdown table when comparing options. No filler, no "As an AI".
- Ground current facts in the numbered WEB SOURCES and cite them inline like [2]. Never invent sources, numbers or URLs. If the sources don't cover something, say you couldn't verify it.
- Prices and plans change: say "as of <month year>" and prefer the most recent, official source.
- MEMORY is the real record of earlier conversations. When asked about the past, quote what the user asked and what you answered, with the date. If MEMORY RESULT says nothing was found, say plainly you have no record of a conversation then, and offer to help now. Never invent a past conversation.
- When asked whether a past answer is still correct or what changed since: compare "facts recorded then" against the web sources now and answer under **Still true**, **Changed** (old → new, with citation), **Couldn't verify**. Give the date each old fact was recorded.
- If web search failed or was unavailable, say so in one short line and label anything from general knowledge as unverified.`;
}

function sourcesBlock(results: SearchResult[]) {
  return results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}${r.published_at ? ` (published ${r.published_at.slice(0, 10)})` : ""}\n${clip(r.content.replace(/\s+/g, " "), 700)}`).join("\n\n");
}

/** After answering: pull out changeable facts so later "has it changed?" is a row-by-row diff. */
async function extractFacts(answerId: number, userId: number, answer: string, results: SearchResult[], planEntities: string[]) {
  let entities = planEntities;
  if (results.length && hasLlm()) {
    try {
      const { data } = await chatJson<{ claims: { entity: string; attribute: string; value: string; source?: number }[] }>("fast", [
        { role: "system", content: `Extract facts from the ANSWER that could change over time (prices, plans, limits, versions, release dates, features, rankings). Reply JSON only: {"claims":[{"entity":"Neon","attribute":"Launch plan price","value":"$19/month","source":2}]}. Max 12. Use the [n] citation in the answer as source. Skip opinions.` },
        { role: "user", content: `ANSWER:\n${clip(answer, 3000)}` },
      ], 1500);
      const at = clock.now().toISOString();
      const claims = (data.claims ?? []).filter((c) => c?.entity && c?.attribute && c?.value).slice(0, 12)
        .map((c) => ({ entity: String(c.entity), attribute: String(c.attribute), value: String(c.value), source_url: c.source ? results[c.source - 1]?.url ?? null : null, observed_at: at }));
      addClaims(answerId, claims);
      entities = [...new Set([...entities, ...claims.map((c) => c.entity)])];
    } catch (e) { console.warn("[facts] extraction skipped:", (e as Error).message); }
  }
  if (entities.length) setTurnEntities(userId, entities);
}

export async function runTurn(input: { conversationId: string; message: string; tzOffset: number }, emit: (e: AgentEvent) => void) {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const timings: Record<string, number> = {};
  const models: string[] = [];
  const { conversationId, message, tzOffset } = input;
  const now = clock.now();
  const nowLocal = formatLocal(now, tzOffset, true);

  if (!hasLlm()) { emit({ type: "error", text: "No LLM key configured. Add GEMINI_API_KEY or GROQ_API_KEY to .env (see .env.example) and restart." }); return; }

  // 1-2. Dates and memory: pure code, ~1 ms.
  const range = refersToPast(message) ? resolveDate(message, now, tzOffset) : null;
  const mem = recall(message, range, conversationId);
  timings.memory = ms();
  if (mem.asked) emit({ type: "memory", range: range?.label ?? null, hits: mem.hits.map((h) => ({ when: formatLocal(h.user.created_at, tzOffset, true), question: h.user.content })) });

  // 3. Plan (skipped for small talk).
  let p: Plan = { intent: "chat", needs_search: false, queries: [], recent_days: null, entities: [] };
  if (!SMALL_TALK.test(message)) {
    const memLines = mem.hits.map((h) => `${formatLocal(h.user.created_at, tzOffset)}: "${clip(h.user.content, 200)}" entities: ${memoryEntities({ ...mem, hits: [h] }).join(", ") || "-"}`).join("\n");
    try {
      const r = await plan(message, mem.recent, memLines, formatLocal(now, tzOffset));
      p = r.plan; models.push(r.model);
    } catch (e) {
      console.warn("[plan] fallback:", (e as Error).message);
      p = { intent: "search", needs_search: true, queries: [message], recent_days: null, entities: [] };
    }
    if (p.needs_search && !p.queries.length) p.queries = [message];
  }
  timings.plan = ms();

  // 4. The one tool.
  let results: SearchResult[] = [];
  let searchNote = "";
  if (p.needs_search) {
    if (!hasSearch()) searchNote = "WEB SEARCH: unavailable (no search API key configured).";
    else {
      emit({ type: "status", text: `Searching: ${p.queries.join(" · ")}` });
      const r = await searchAll(p.queries, p.recent_days ?? undefined);
      results = r.results;
      if (!results.length) searchNote = `WEB SEARCH: failed or returned nothing${r.errors.length ? ` (${clip(r.errors[0], 120)})` : ""}.`;
      emit({ type: "sources", sources: results.map((s, i) => ({ n: i + 1, title: s.title, url: s.url, published_at: s.published_at })) });
    }
  }
  timings.search = ms();

  // 5. Answer, streamed.
  emit({ type: "status", text: mem.hits.length && results.length ? "Comparing with what you asked before…" : "Writing…" });
  const history: Msg[] = mem.recent.map((t) => ({ role: t.role, content: clip(t.content, 1500) }));
  const context = [memoryContext(mem, tzOffset), results.length ? `WEB SOURCES (searched ${nowLocal}):\n${sourcesBlock(results)}` : searchNote].filter(Boolean).join("\n\n");
  const messages: Msg[] = [
    { role: "system", content: answerSystem(nowLocal, tzOffset) },
    ...history,
    { role: "user", content: context ? `<context>\n${context}\n</context>\n\n${message}` : message },
  ];
  let first = 0;
  let text = "";
  try {
    // Nothing to ground (small talk, no memory, no sources): the fast model answers, the strong one isn't needed.
    const role = !results.length && !mem.asked && p.intent === "chat" ? "fast" : "answer";
    const r = await chatStream(role, messages, (tok) => { if (!first) first = ms(); emit({ type: "token", text: tok }); });
    text = r.text; models.push(r.model);
  } catch (e) {
    emit({ type: "error", text: `The language model is unavailable right now: ${clip((e as Error).message, 300)}` });
    return;
  }
  timings.firstToken = first;
  timings.total = ms();

  // Question and answer are written together, only after success: no orphaned questions,
  // and the pair stays adjacent even if two turns run at once.
  const userId = addTurn({ conversation_id: conversationId, role: "user", content: message, created_at: now.toISOString(), tz_offset: tzOffset, intent: p.intent, entities: JSON.stringify(p.entities) });
  const answerId = addTurn({ conversation_id: conversationId, role: "assistant", content: text, created_at: clock.now().toISOString(), tz_offset: tzOffset, intent: p.intent, entities: null });
  addSources(answerId, results.map((s, i) => ({ n: i + 1, url: s.url, title: s.title, published_at: s.published_at, fetched_at: now.toISOString(), excerpt: clip(s.content, 500) })));
  emit({ type: "done", turnId: answerId, timings, models, searched: p.needs_search && results.length > 0 });

  // 6. Memory write happens after the user already has the answer.
  return extractFacts(answerId, userId, text, results, p.entities);
}
