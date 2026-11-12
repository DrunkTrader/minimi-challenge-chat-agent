import { q, type Turn, type Claim, type Source } from "./db.js";
import { formatLocal, type DateRange } from "./dates.js";

/**
 * Memory is NOT a tool the model may or may not call. It's deterministic context
 * assembly: dates resolved in code → SQL by time range + FTS keywords → the exact
 * past question, the answer given, and the structured facts recorded at the time.
 */
export type MemoryHit = { user: Turn; answer?: Turn; claims: Claim[]; sources: Source[] };
export type Recall = { range: DateRange | null; hits: MemoryHit[]; recent: Turn[]; asked: boolean };

const STOP = new Set("about above after again also asked been before being could does doing from have having here into just last like more most much only other over same should since some than that their them then there these they this those through today very what when where which while will with would your yours you’re week month monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december yesterday still correct answer answers changed change anything since ago earlier tell said told".split(" "));

export const keywords = (text: string) =>
  [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9.+-]{2,}/g) ?? [])].filter((w) => !STOP.has(w) && !/^\d+$/.test(w)).slice(0, 8);

const REFERS_TO_PAST = /\b(i|we) (ask|asked|told|said|discussed|shortlisted|talked|mentioned|chose|picked)\b|\b(did|have) (i|we) (ask|say|mention|discuss)|\byou (said|told|answered|recommended|suggested)|\blast time\b|\bearlier\b|\bbefore\b|\bprevious(ly)?\b|\bremember\b|\bstill (correct|true|valid|right|accurate)\b|\bchanged since\b|\bsince then\b/i;

/** Only conversation-about-the-past messages get date resolution, so "Python 3.13 released in March?" stays a plain search. */
export const refersToPast = (text: string) => REFERS_TO_PAST.test(text);

function hydrate(user: Turn): MemoryHit {
  const answer = q.answerFor(user);
  return { user, answer, claims: answer ? q.claimsFor([answer.id]) : [], sources: answer ? q.sourcesFor(answer.id) : [] };
}

export function recall(message: string, range: DateRange | null, conversationId: string): Recall {
  const recent = q.recent(conversationId, 8);
  const recentIds = new Set(recent.map((t) => t.id));
  const words = keywords(message);
  const asked = Boolean(range) || REFERS_TO_PAST.test(message);
  let users: Turn[] = [];

  if (range) {
    const inRange = q.turnsBetween(range.startIso, range.endIso).filter((t) => t.role === "user" && !recentIds.has(t.id));
    const score = (t: Turn) => words.filter((w) => (t.content + " " + (t.entities ?? "")).toLowerCase().includes(w)).length;
    const matched = inRange.filter((t) => score(t) > 0).sort((a, b) => score(b) - score(a));
    users = (matched.length ? matched : inRange).slice(0, 6);
  } else if (asked && words.length) {
    const fts = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
    try {
      // A match in an answer counts too: map it back to the question that produced it.
      const seen = new Set<number>();
      for (const t of q.search(fts, 12)) {
        const u = t.role === "user" ? t : q.questionFor(t);
        if (u && !recentIds.has(u.id) && !seen.has(u.id)) { seen.add(u.id); users.push(u); }
      }
      users = users.slice(0, 3);
    } catch { users = []; }
  }
  return { range, hits: users.map(hydrate), recent, asked };
}

/** Compact text block for the prompt. Explicitly says when nothing was found. */
export function memoryContext(r: Recall, tzOffset: number): string {
  if (!r.asked) return "";
  const head = r.range ? `The user is referring to ${r.range.label}${r.range.endIso && /since/i.test(r.range.text) ? " onwards" : ""} (resolved from "${r.range.text}").` : "The user is referring to an earlier conversation.";
  if (!r.hits.length) return `${head}\nMEMORY RESULT: no past conversation found for that ${r.range ? "date" : "topic"}. Say so plainly; do not invent one.`;
  const blocks = r.hits.map((h, i) => {
    const facts = h.claims.map((c) => `    - ${c.entity} · ${c.attribute}: ${c.value} (recorded ${formatLocal(c.observed_at, tzOffset)}${c.source_url ? `, ${c.source_url}` : ""})`).join("\n");
    return [
      `[M${i + 1}] ${formatLocal(h.user.created_at, tzOffset, true)} — user asked: "${h.user.content}"`,
      h.answer ? `  my answer then: ${h.answer.content.slice(0, 900)}${h.answer.content.length > 900 ? "…" : ""}` : "  (no answer stored)",
      facts ? `  facts recorded then:\n${facts}` : "",
    ].filter(Boolean).join("\n");
  });
  return `${head}\nMEMORY RESULT (${r.hits.length} past exchange${r.hits.length > 1 ? "s" : ""}):\n${blocks.join("\n")}`;
}

/** Entities to re-check: recorded claim entities + stored turn entities. */
export function memoryEntities(r: Recall): string[] {
  const set = new Set<string>();
  for (const h of r.hits) {
    h.claims.forEach((c) => set.add(c.entity));
    try { (JSON.parse(h.user.entities ?? "[]") as string[]).forEach((e) => set.add(e)); } catch { /* ignore */ }
  }
  return [...set].slice(0, 8);
}
