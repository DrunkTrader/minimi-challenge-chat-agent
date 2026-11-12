import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";

/**
 * Keys and fallback order the user sets in the UI. Stored in data/settings.json (git-ignored,
 * mode 600), layered over .env: a key set in the UI wins, "disabled" switches a provider off
 * whatever its source, and an empty order falls back to LLM_ORDER_* or the built-in default.
 * Key values never leave this module except to call the provider; the API only sees a mask.
 */
export const LLMS = ["gemini", "groq", "openai", "deepseek", "openrouter"] as const;
export const SEARCHES = ["tavily", "exa"] as const;
export type Llm = (typeof LLMS)[number];
export type Search = (typeof SEARCHES)[number];
export type Provider = Llm | Search;

type Stored = {
  keys: Partial<Record<Provider, string>>;
  disabled: Provider[];
  models: Partial<Record<Llm, string[]>>;
  order: { answer?: Llm[]; fast?: Llm[]; search?: Search[] };
  openaiBase?: string;
};

const META: Record<Provider, { label: string; env: string; url: string; free: boolean }> = {
  gemini: { label: "Google Gemini", env: "GEMINI_API_KEY", url: "https://aistudio.google.com/apikey", free: true },
  groq: { label: "Groq", env: "GROQ_API_KEY", url: "https://console.groq.com/keys", free: true },
  openai: { label: "OpenAI / compatible", env: "OPENAI_API_KEY", url: "https://platform.openai.com/api-keys", free: false },
  deepseek: { label: "DeepSeek", env: "DEEPSEEK_API_KEY", url: "https://platform.deepseek.com/api_keys", free: false },
  openrouter: { label: "OpenRouter", env: "OPENROUTER_API_KEY", url: "https://openrouter.ai/keys", free: true },
  tavily: { label: "Tavily", env: "TAVILY_API_KEY", url: "https://app.tavily.com", free: true },
  exa: { label: "Exa", env: "EXA_API_KEY", url: "https://dashboard.exa.ai", free: true },
};
export const DEFAULT_ORDER = {
  answer: ["gemini", "openai", "deepseek", "groq", "openrouter"] as Llm[],
  fast: ["groq", "openai", "deepseek", "gemini", "openrouter"] as Llm[],
  search: ["tavily", "exa"] as Search[],
};

const file = () => (config.dbPath === ":memory:" ? null : join(dirname(config.dbPath), "settings.json"));
let s: Stored = load();

function load(): Stored {
  const empty: Stored = { keys: {}, disabled: [], models: {}, order: {} };
  const f = file();
  if (!f || !existsSync(f)) return empty;
  try { return { ...empty, ...JSON.parse(readFileSync(f, "utf8")) }; } catch { return empty; }
}
function save() {
  const f = file(); if (!f) return;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(s, null, 2), { mode: 0o600 });
}

const envKey = (p: Provider) => (process.env[META[p].env] || "").trim();
export const key = (p: Provider): string => (s.disabled.includes(p) ? "" : (s.keys[p] || envKey(p)));
export const openaiBase = () => (s.openaiBase || config.openaiBase).replace(/\/$/, "");
export const models = (p: Llm): string[] => (s.models[p]?.length ? s.models[p]! : config.models[p]);

function envOrder<T extends string>(env: string | undefined, all: readonly T[]): T[] {
  return (env ?? "").split(",").map((x) => x.trim()).filter((x): x is T => all.includes(x as T));
}
/** UI order first, then LLM_ORDER_* env, then the default; anything unlisted is appended so nothing is lost. */
export function order(role: "answer" | "fast"): Llm[] {
  const env = envOrder(role === "answer" ? process.env.LLM_ORDER_ANSWER : process.env.LLM_ORDER_FAST, LLMS);
  return [...new Set([...(s.order[role] ?? []), ...env, ...DEFAULT_ORDER[role], ...LLMS])];
}
export const searchOrder = (): Search[] => [...new Set([...(s.order.search ?? []), ...DEFAULT_ORDER.search])];

const mask = (k: string) => (k.length > 8 ? `…${k.slice(-4)}` : "set");

/** What the browser may see: status and masks, never a key. */
export function view() {
  const row = (p: Provider) => ({
    id: p, label: META[p].label, url: META[p].url, free: META[p].free, env: META[p].env,
    source: s.keys[p] ? "ui" : envKey(p) ? "env" : null,
    mask: s.keys[p] ? mask(s.keys[p]!) : envKey(p) ? mask(envKey(p)) : null,
    disabled: s.disabled.includes(p),
    active: Boolean(key(p)),
    ...((LLMS as readonly string[]).includes(p) ? { models: models(p as Llm), defaultModels: config.models[p as Llm], custom: Boolean(s.models[p as Llm]?.length) } : {}),
  });
  return {
    llms: LLMS.map(row), searches: SEARCHES.map(row),
    order: { answer: order("answer"), fast: order("fast"), search: searchOrder() },
    openaiBase: openaiBase(),
  };
}

export type Patch = {
  keys?: Partial<Record<Provider, string | null>>;
  disabled?: Partial<Record<Provider, boolean>>;
  models?: Partial<Record<Llm, string | null>>;
  order?: { answer?: string[]; fast?: string[]; search?: string[] };
  openaiBase?: string | null;
};

const isProvider = (x: string): x is Provider => (LLMS as readonly string[]).includes(x) || (SEARCHES as readonly string[]).includes(x);

/** Validated update. Unknown providers and odd values are ignored rather than stored. */
export function update(p: Patch) {
  for (const [id, v] of Object.entries(p.keys ?? {})) {
    if (!isProvider(id)) continue;
    if (v === null || v === "") delete s.keys[id];
    else if (typeof v === "string" && /^[\x21-\x7e]{8,300}$/.test(v.trim())) s.keys[id] = v.trim();
    else throw new Error(`That doesn't look like an API key for ${META[id].label}.`);
  }
  for (const [id, off] of Object.entries(p.disabled ?? {})) {
    if (!isProvider(id)) continue;
    s.disabled = s.disabled.filter((x) => x !== id);
    if (off) s.disabled.push(id);
  }
  for (const [id, v] of Object.entries(p.models ?? {})) {
    if (!(LLMS as readonly string[]).includes(id)) continue;
    const list = typeof v === "string" ? v.split(",").map((x) => x.trim()).filter((x) => /^[\w./:@-]{1,100}$/.test(x)).slice(0, 8) : [];
    if (list.length) s.models[id as Llm] = list; else delete s.models[id as Llm];
  }
  if (p.order) {
    if (Array.isArray(p.order.answer)) s.order.answer = p.order.answer.filter((x): x is Llm => (LLMS as readonly string[]).includes(x));
    if (Array.isArray(p.order.fast)) s.order.fast = p.order.fast.filter((x): x is Llm => (LLMS as readonly string[]).includes(x));
    if (Array.isArray(p.order.search)) s.order.search = p.order.search.filter((x): x is Search => (SEARCHES as readonly string[]).includes(x));
  }
  if (p.openaiBase !== undefined) {
    if (!p.openaiBase) delete s.openaiBase;
    else if (/^https?:\/\/\S+$/.test(p.openaiBase.trim())) s.openaiBase = p.openaiBase.trim();
    else throw new Error("Base URL must start with http:// or https://");
  }
  save();
  return view();
}
