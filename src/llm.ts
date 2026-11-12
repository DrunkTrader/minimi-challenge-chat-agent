import { config } from "./config.js";

/**
 * One small client for every provider: Groq, Gemini and OpenRouter all speak the
 * OpenAI chat-completions protocol, so no SDKs. Each role has an ordered chain of
 * (provider, model); a 429 / 5xx / retired model just moves to the next link.
 */
export type Msg = { role: "system" | "user" | "assistant"; content: string };
type Link = { provider: string; base: string; key: string; model: string };

const P = {
  groq: { base: "https://api.groq.com/openai/v1", key: () => config.keys.groq, models: () => config.models.groq },
  gemini: { base: "https://generativelanguage.googleapis.com/v1beta/openai", key: () => config.keys.gemini, models: () => config.models.gemini },
  openrouter: { base: "https://openrouter.ai/api/v1", key: () => config.keys.openrouter, models: () => config.models.openrouter },
};
type Name = keyof typeof P;

function chain(order: Name[]): Link[] {
  return order.flatMap((name) => {
    const p = P[name];
    return p.key() ? p.models().map((model) => ({ provider: name, base: p.base, key: p.key(), model })) : [];
  });
}
/** Fast role: planner + memory extraction. Answer role: the user-facing reply. */
export const roles = { fast: (): Link[] => chain(["groq", "gemini", "openrouter"]), answer: (): Link[] => chain(["gemini", "groq", "openrouter"]) };
export const hasLlm = () => roles.answer().length > 0;

const dead = new Set<string>();           // models that returned 404 this process: skip for good
const coolUntil = new Map<string, number>(); // 429 / 503 ("high demand"): skip for a minute instead of paying the wait every turn

async function request(links: Link[], body: Record<string, unknown>, timeoutMs: number) {
  const errors: string[] = [];
  const usable = links.filter((l) => !dead.has(`${l.provider}:${l.model}`));
  const cooling = (l: Link) => (coolUntil.get(`${l.provider}:${l.model}`) ?? 0) > Date.now();
  // Fresh models first; ones cooling down after a 429/503 stay as a last resort rather than being dropped.
  const ordered = [...usable.filter((l) => !cooling(l)), ...usable.filter(cooling)];
  const plain = new Set<string>(); // links that rejected the reasoning parameter: retried once without it
  for (let i = 0; i < ordered.length; i++) {
    const l = ordered[i];
    const id = `${l.provider}:${l.model}`;
    // Thinking costs latency: measured on Gemini 3.5 Flash, first token 43 s by default vs 1.4 s with
    // reasoning off. Answers are grounded in search results, so default to none (GEMINI_REASONING to change).
    const extra = plain.has(id) ? {}
      : l.model.includes("gpt-oss") ? { reasoning_effort: "low" }
      : l.model.includes("qwen3") ? { reasoning_effort: "none" }
      : l.provider === "gemini" && config.geminiReasoning !== "default" ? { reasoning_effort: config.geminiReasoning } : {};
    try {
      const res = await fetch(`${l.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${l.key}` },
        body: JSON.stringify({ model: l.model, ...body, ...extra }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { res, link: l };
      const text = (await res.text()).slice(0, 200);
      if (res.status === 400 && "reasoning_effort" in extra && !plain.has(id)) { plain.add(id); ordered.splice(i + 1, 0, l); continue; }
      if (res.status === 404 || /not.?found|decommission|does not exist|no longer available/i.test(text)) dead.add(id);
      else if (res.status === 429 || res.status >= 500) coolUntil.set(id, Date.now() + 60_000);
      errors.push(`${id} → ${res.status} ${text}`);
    } catch (e) {
      errors.push(`${id} → ${(e as Error).message}`);
    }
  }
  throw new Error(links.length ? `All models failed: ${errors.join(" | ")}` : "No LLM API key configured (see .env.example)");
}

export async function chatJson<T>(role: keyof typeof roles, messages: Msg[], maxTokens = 1000): Promise<{ data: T; model: string }> {
  let links = roles[role]();
  for (;;) {
    const { res, link } = await request(links, { messages, temperature: 0, max_tokens: maxTokens, response_format: { type: "json_object" } }, 15_000);
    try {
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      const text = json.choices?.[0]?.message?.content ?? "";
      const match = text.match(/\{[\s\S]*\}/);
      return { data: JSON.parse(match ? match[0] : text) as T, model: `${link.provider}:${link.model}` };
    } catch (e) {
      // Truncated or non-JSON output: try the next model in the chain instead of failing the turn.
      links = links.slice(links.indexOf(link) + 1);
      if (!links.length) throw e;
    }
  }
}

// Generous budget: "thinking" models (e.g. Gemini Flash) spend part of it before the first visible token.
export async function chatStream(role: keyof typeof roles, messages: Msg[], onToken: (t: string) => void, maxTokens = 4000) {
  const { res, link } = await request(roles[role](), { messages, temperature: 0.2, max_tokens: maxTokens, stream: true }, 60_000);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "", full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, "").trim();
      if (!line.startsWith("data:") || !data || data === "[DONE]") continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) { full += delta; onToken(delta); }
      } catch { /* partial keep-alive lines */ }
    }
  }
  return { text: full, model: `${link.provider}:${link.model}` };
}
