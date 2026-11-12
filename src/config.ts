import { existsSync, readFileSync } from "node:fs";

/** Tiny .env loader (no dependency): KEY=VALUE lines, # comments. Real env vars win. */
export function loadEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const list = (v: string | undefined, d: string) => (v || d).split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || "data/memory.db",
  keys: {
    gemini: process.env.GEMINI_API_KEY || "",
    groq: process.env.GROQ_API_KEY || "",
    openrouter: process.env.OPENROUTER_API_KEY || "",
    tavily: process.env.TAVILY_API_KEY || "",
    exa: process.env.EXA_API_KEY || "",
  },
  models: {
    groq: list(process.env.FAST_MODELS_GROQ, "openai/gpt-oss-20b,llama-3.3-70b-versatile,llama-3.1-8b-instant"),
    gemini: list(process.env.ANSWER_MODELS_GEMINI, "gemini-flash-latest,gemini-2.5-flash"),
    openrouter: list(process.env.OPENROUTER_MODELS, "meta-llama/llama-3.3-70b-instruct:free"),
  },
};

/**
 * Single source of "now". Everything time-related goes through this so demos
 * and evals can freeze the clock (NOW=... or clock.set()) without touching code.
 */
let frozen: Date | null = process.env.NOW ? new Date(process.env.NOW) : null;
export const clock = {
  now: () => (frozen ? new Date(frozen) : new Date()),
  set: (d: Date | null) => { frozen = d; },
};
