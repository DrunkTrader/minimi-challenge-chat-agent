# minimi chat

*My entry for the [minimi](https://www.projectminimi.com/) hiring challenge. It's not an official minimi product; the colours follow their site.*

A chat agent with one tool, **web search**, that answers fast, cites its sources, and **remembers what you asked and when**, so it can answer *"Last Tuesday I asked you about Postgres hosting, has any pricing changed since?"* by diffing then vs now.

## Run it

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`, so there are no native installs).

```bash
npm install
cp .env.example .env   # add keys, all free tiers, no card
npm run dev            # → http://localhost:3000
```

Minimum keys: one model key (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`) plus `TAVILY_API_KEY`. The free pair Gemini + Groq is the fastest setup (Groq plans, Gemini answers), and every key you add becomes a fallback. `OPENAI_BASE_URL` points the OpenAI slot at any compatible server (e.g. Ollama), and `LLM_ORDER_FAST` / `LLM_ORDER_ANSWER` choose which provider goes first.

You can also manage keys in the app: **⚙ Settings** (bottom of the sidebar) adds, tests, disables or removes a key for each provider, edits model lists, and sets the fallback order separately for answers, the planner and web search. Keys set there go to `data/settings.json` (git-ignored, owner-only) and override `.env`. The API only ever returns a mask like `…3f9a`, and settings accept requests only from this machine and this page.

## Try it

On first start the app **seeds backdated demo history** so memory can be tested right away (see "Demo history" in the sidebar):

| when | what was asked |
|---|---|
| 3 Nov | Cursor Pro vs GitHub Copilot Pro pricing |
| last Monday | Shortlist 5 CRMs for a 20-person sales team |
| last Tuesday | Managed Postgres hosting options and prices |

Then ask:
- *What did I ask you on 3 November? Is your answer still correct today?*
- *On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?*
- *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?*
- *What did I ask you on 1 November?* (it should say it has no record, not make one up)

The demo prices are illustrative and recorded "as of" their date, so a re-check may well find they've changed. That is the point of re-checking. **Reset demo history** in the sidebar re-creates them relative to today.

## Results

`npm run eval` runs 11 end-to-end cases through the real agent (live models and search, a fresh database seeded with the demo history) and checks each one deterministically: did it search, did it cite, did it say "no record", did it state the date it used. Latest run on free tiers (Groq + Gemini + Tavily):

| | |
|---|---|
| Passed | **11 / 11** |
| First word, p50 / p95 | **3.1 s / 5.4 s** (small talk: 0.9 s) |
| Total, p50 | 3.3 s |

The per-case table, including which model answered each case, is in [evals/results.md](evals/results.md).

## Scripts

| | |
|---|---|
| `npm run dev` | server + UI with reload |
| `npm test` | date resolution + memory retrieval tests (no keys needed) |
| `npm run eval` | end-to-end eval of 11 cases with real models + search → `evals/results.md` |
| `npm run seed` | re-create the demo history |
| `npm run typecheck` | `tsc --noEmit` |

## Layout

```
src/agent.ts    the turn: dates → memory → plan → web_search → streamed answer → fact extraction
src/memory.ts   recall by date range + FTS, prompt context, "no record" handling
src/dates.ts    "last Tuesday" / "3 November" → local-day ranges (chrono-node, tz-aware)
src/search.ts   the one tool: Tavily → Exa fallback, parallel, deduped, cached
src/llm.ts      one OpenAI-compatible client for Groq / Gemini / OpenAI (or any compatible server) / DeepSeek /
                OpenRouter: per-role fallback chains, cooldown on 429/503, reasoning-param fallback
src/db.ts       SQLite schema: turns (+FTS5), sources, claims, search_cache
src/server.ts   node:http, NDJSON streaming
public/         single-file UI: memory timeline, live pipeline tracker (memory → plan → search → answer → saved),
                then-vs-now verdict blocks, source cards, light/dark; public/assets/graph.js: Obsidian-style memory graph
                (chats, topics, days; force layout, no library); public/assets/motion: taste-skill motion layer
                (MIT, see public/assets/LICENSE-taste-skill)
```

Design rationale: [DESIGN.md](DESIGN.md).
