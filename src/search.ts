import { clock } from "./config.js";
import * as settings from "./settings.js";
import type { Search } from "./settings.js";
import { q } from "./db.js";

/**
 * The agent's one tool. Provider-agnostic: Tavily first, Exa as fallback, both
 * normalised to the same shape. Results are cached for 30 min so repeated or
 * parallel identical queries cost nothing (and free-tier quotas last).
 */
export type SearchResult = { title: string; url: string; content: string; published_at: string | null };
const TTL_MS = 30 * 60_000;

async function tavily(query: string, recentDays?: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${settings.key("tavily")}` },
    body: JSON.stringify({ query, max_results: 5, search_depth: "basic", ...(recentDays ? { days: recentDays, topic: "news" } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const j = (await res.json()) as { results: { title: string; url: string; content: string; published_date?: string }[] };
  return j.results.map((r) => ({ title: r.title, url: r.url, content: r.content, published_at: r.published_date ?? null }));
}

async function exa(query: string): Promise<SearchResult[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": settings.key("exa") },
    body: JSON.stringify({ query, numResults: 5, contents: { text: { maxCharacters: 1200 } } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const j = (await res.json()) as { results: { title: string; url: string; text?: string; publishedDate?: string }[] };
  return j.results.map((r) => ({ title: r.title, url: r.url, content: r.text ?? "", published_at: r.publishedDate ?? null }));
}

export const hasSearch = () => settings.SEARCHES.some((p) => settings.key(p));

/** Settings "Test" button: one uncached query through a single provider. */
export async function testSearch(p: Search) {
  if (!settings.key(p)) throw new Error("No key set");
  const t = Date.now();
  const r = await (p === "tavily" ? tavily("node.js lts version") : exa("node.js lts version"));
  return { ok: true, ms: Date.now() - t, model: `${r.length} results` };
}

export async function webSearch(query: string, opts: { recentDays?: number } = {}): Promise<{ results: SearchResult[]; cached: boolean }> {
  const key = `${query.toLowerCase().replace(/\s+/g, " ").trim()}|${opts.recentDays ?? ""}`;
  const hit = q.cacheGet(key);
  if (hit && clock.now().getTime() - new Date(hit.fetched_at).getTime() < TTL_MS) return { results: JSON.parse(hit.results), cached: true };

  const run: Record<Search, () => Promise<SearchResult[]>> = { tavily: () => tavily(query, opts.recentDays), exa: () => exa(query) };
  const providers = settings.searchOrder().filter((p) => settings.key(p)).map((p) => run[p]); // Settings order, keyed ones only
  if (!providers.length) throw new Error("No search API key configured (see .env.example)");
  let lastErr: unknown;
  for (const run of providers) {
    try {
      const results = await run();
      q.cachePut(key, JSON.stringify(results), clock.now().toISOString());
      return { results, cached: false };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/** Run several queries in parallel, dedupe by URL, keep the best few per query. */
export async function searchAll(queries: string[], recentDays?: number) {
  const settled = await Promise.allSettled(queries.map((qq) => webSearch(qq, { recentDays })));
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  const errors: string[] = [];
  for (const s of settled) {
    if (s.status === "rejected") { errors.push(String((s.reason as Error)?.message ?? s.reason)); continue; }
    for (const r of s.value.results.slice(0, 4)) {
      const u = r.url.replace(/[#?].*$/, "").replace(/\/$/, "");
      if (!seen.has(u)) { seen.add(u); results.push(r); }
    }
  }
  return { results: results.slice(0, 10), errors };
}
