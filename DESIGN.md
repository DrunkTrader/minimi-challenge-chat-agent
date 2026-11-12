# DESIGN

**The key observation:** the test questions aren't search questions, they're *memory* questions. "What did I ask on 3 November, is it still correct?" needs four things: resolve the date, recall the exact exchange, know what facts it rested on, and re-check those facts against the web. So time and facts are the core data here, not chat logs added on afterwards. It's minimi's own problem in miniature: remember what was said and when, and notice when it goes stale.

## How it works

```
message ─► dates (code) ─► memory (SQL) ─► planner (fast LLM, JSON) ─► web_search ×N (parallel)
                                                                    └► answer (streamed, cited) ─► facts → memory (async)
```

1. **Dates in code.** `chrono-node` turns "last Tuesday" / "on Monday" / "3 November" into a local-day range using the browser's UTC offset. A weekday in the future is moved back a week, because memory questions are about the past.
2. **Memory is context, not a tool.** The brief allows one tool. Recall is deterministic: SQL by time range, with FTS5 keywords for "earlier I asked about Supabase". It returns the exact question, the answer given, and the **facts recorded then**. If nothing matches, the prompt says so explicitly, and the agent says "no record" instead of inventing one.
3. **Planner.** A small fast model (Groq) sees the message plus the memory summary and returns `{intent, needs_search, queries, entities}`. Re-check questions get one query per remembered entity (the five CRMs → five parallel searches). Small talk skips planning and search entirely.
4. **The one tool.** `web_search` is provider-agnostic (Tavily, falling back to Exa), runs in parallel, dedupes by URL, and caches for 30 minutes.
5. **Answer.** It streams with numbered citations. For "is it still correct?" it uses a fixed structure: **Still true / Changed (old → new) / Couldn't verify**, each old fact with the date it was recorded.
6. **Facts back to memory.** After the user has their answer, a cheap call extracts facts that can change (`entity · attribute · value · source · observed_at`) into `claims`. "Has pricing changed?" then becomes a row-by-row diff, not the model re-reading old prose.

## Why it's built this way

- **Speed:** memory is ~1 ms of SQL, there's one small planning call, searches run in parallel, the answer streams, and the memory write happens after the response. There's no agent loop of model → tool → model round trips.
- **Correctness:** dates and recall are code, so they're testable (`npm test`). Answers must cite sources. Missing memory and failed search are reported, not hidden.
- **Runs anywhere:** built-in `node:sqlite`, no native builds, no database server, three runtime dependencies. One OpenAI-compatible client covers Groq, Gemini and OpenRouter, each with a fallback chain (a 429 or a retired model moves on to the next). Every key has a free tier.

## Considered and rejected

- **LangChain / multi-agent graphs:** more layers and latency for a linear pipeline, and harder to explain line by line.
- **Memory as a second tool, or letting the model resolve dates:** breaks the one-tool rule, adds a round trip, and models are unreliable at "which date was last Tuesday?".
- **Vector DB / embeddings:** an external service for a problem where *time* is the main key. Date range + FTS5 covers it.
- **Zep/Graphiti temporal knowledge graph:** the right idea (timestamped facts, never overwrite) at the wrong size. I borrowed the idea, not the dependency.
- **A page-fetch tool:** a second tool. The search API already returns page text.
- **Provider-hosted search (Gemini grounding etc.):** no control over sources, caching, or the then-vs-now diff.

## With another week

- **Proactive re-checks:** "watch these 5 CRMs" → a scheduled re-search → a nudge only when a fact actually changes. That's minimi's core loop.
- Bi-temporal claims (valid-from / superseded-at) so "what was true on 3 Nov" and "what changed" are queries, not prompts.
- Embeddings for fuzzy recall ("that database thing"), a search-result reranker, and a second search round when sources disagree.
- A bigger eval set with an LLM judge, CI on every commit, and per-step latency tracing.
