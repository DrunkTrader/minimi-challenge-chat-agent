# minimi chat

A chat agent with one tool, **web search**, that answers fast, cites its sources, and **remembers what you asked and when**, so it can answer *"Last Tuesday I asked you about Postgres hosting, has any pricing changed since?"* by diffing then vs now.

## Run it

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`, so there are no native installs).

```bash
npm install
cp .env.example .env   # add keys, all free tiers, no card
npm run dev            # → http://localhost:3000
```

Minimum keys: `GEMINI_API_KEY` or `GROQ_API_KEY`, plus `TAVILY_API_KEY`. Using both Gemini and Groq gives the fastest setup (Groq plans, Gemini answers) and each acts as the other's fallback.

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

## Scripts

| | |
|---|---|
| `npm run dev` | server + UI with reload |
| `npm test` | date resolution + memory retrieval tests (no keys needed) |
| `npm run eval` | end-to-end eval of 9 cases with real models + search → `evals/results.md` |
| `npm run seed` | re-create the demo history |
| `npm run typecheck` | `tsc --noEmit` |

## Layout

```
src/agent.ts    the turn: dates → memory → plan → web_search → streamed answer → fact extraction
src/memory.ts   recall by date range + FTS, prompt context, "no record" handling
src/dates.ts    "last Tuesday" / "3 November" → local-day ranges (chrono-node, tz-aware)
src/search.ts   the one tool: Tavily → Exa fallback, parallel, deduped, cached
src/llm.ts      one OpenAI-compatible client for Groq / Gemini / OpenRouter with fallback chains
src/db.ts       SQLite schema: turns (+FTS5), sources, claims, search_cache
src/server.ts   node:http, NDJSON streaming
public/         single-file UI: memory timeline, live pipeline tracker (memory → plan → search → answer → saved),
                then-vs-now verdict blocks, source cards; public/assets: taste-skill motion layer + ascii-shade
                effect (MIT, see public/assets/LICENSE-taste-skill)
```

Design rationale: [DESIGN.md](DESIGN.md).
