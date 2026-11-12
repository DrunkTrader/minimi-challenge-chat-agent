import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * npm run eval: runs evals/cases.json through the real agent (real LLM + search
 * calls) against a throwaway DB seeded with the demo history and IST. Checks are
 * deterministic (searched? cited? must-include regex? latency), so results are
 * cheap to read and hard to fool. Writes evals/results.md.
 */
const dbPath = join(tmpdir(), `minimi-eval-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
const IST = -330;

const { clock } = await import("../src/config.js");
const { seedDemo } = await import("../src/seed.js");
const { runTurn } = await import("../src/agent.js");
const { hasLlm } = await import("../src/llm.js");
const { hasSearch } = await import("../src/search.js");
if (!hasLlm() || !hasSearch()) { console.error("Evals need an LLM key and a search key in .env"); process.exit(1); }

const now = clock.now();
seedDemo(now, IST);

type Case = { id: string; turns: string[]; expect: { search?: boolean; citations?: boolean; include?: string[]; maxFirstTokenMs?: number } };
const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as Case[];
const rows: { id: string; pass: boolean; why: string; first: number; total: number; model: string }[] = [];

// Free tiers allow ~8k tokens/min (Groq) and a few requests/min (Gemini): pace the cases like a person would.
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS ?? 8000);
for (const c of cases) {
  if (c !== cases[0]) await new Promise((r) => setTimeout(r, PAUSE_MS));
  const conv = `eval-${c.id}`;
  let text = "", searched = false, first = 0, total = 0, error = "", models: string[] = [];
  for (const turn of c.turns) {
    text = ""; error = "";
    await runTurn({ conversationId: conv, message: turn, tzOffset: IST }, (e) => {
      if (e.type === "token") text += e.text;
      if (e.type === "error") error = e.text;
      if (e.type === "done") { searched = e.searched; first = e.timings.firstToken; total = e.timings.total; models = e.models; }
    });
  }
  const fails: string[] = [];
  if (error) fails.push(`error: ${error.slice(0, 80)}`);
  if (c.expect.search !== undefined && searched !== c.expect.search) fails.push(`search=${searched}`);
  if (c.expect.citations && !/\[\d+(?:\s*,\s*\d+)*\]/.test(text)) fails.push("no citations");
  for (const re of c.expect.include ?? []) if (!new RegExp(re, "i").test(text)) fails.push(`missing /${re.slice(0, 40)}/`);
  if (c.expect.maxFirstTokenMs && first > c.expect.maxFirstTokenMs) fails.push(`slow ${first}ms`);
  const model = models.at(-1) ?? "-";
  rows.push({ id: c.id, pass: !fails.length, why: fails.join("; "), first, total, model });
  console.log(`${fails.length ? "✗" : "✓"} ${c.id.padEnd(26)} first ${String(first).padStart(5)}ms  total ${String(total).padStart(5)}ms  ${model.padEnd(32)} ${fails.join("; ")}`);
  if (fails.length && process.env.EVAL_VERBOSE) console.log("   " + text.slice(0, 400).replace(/\n/g, "\n   "));
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const firsts = rows.map((r) => r.first).filter(Boolean), totals = rows.map((r) => r.total).filter(Boolean);
const passed = rows.filter((r) => r.pass).length;
const md = `# Eval results\n\nRun: ${now.toISOString()} · ${passed}/${rows.length} passed · first token p50 ${pct(firsts, 0.5)}ms / p95 ${pct(firsts, 0.95)}ms · total p50 ${pct(totals, 0.5)}ms\n\n| case | pass | first token | total | answered by | notes |\n|---|---|---|---|---|---|\n${rows.map((r) => `| ${r.id} | ${r.pass ? "pass" : "FAIL"} | ${r.first}ms | ${r.total}ms | ${r.model} | ${r.why} |`).join("\n")}\n`;
writeFileSync(new URL("./results.md", import.meta.url), md);
console.log(`\n${passed}/${rows.length} passed → evals/results.md`);
try { rmSync(dbPath, { force: true }); } catch { /* windows may hold the file */ }
process.exit(0);
