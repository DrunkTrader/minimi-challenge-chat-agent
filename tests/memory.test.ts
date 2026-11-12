import { test } from "node:test";
import assert from "node:assert/strict";

// Isolated in-memory DB + frozen clock: Thu 12 Nov 2026, 15:30 IST.
process.env.DB_PATH = ":memory:";
const IST = -330;
const now = new Date("2026-11-12T10:00:00Z");
const { clock } = await import("../src/config.js");
clock.set(now);
const { seedDemo } = await import("../src/seed.js");
const { recall, memoryContext, memoryEntities } = await import("../src/memory.js");
const { resolveDate } = await import("../src/dates.js");
seedDemo(now, IST);

const { refersToPast } = await import("../src/memory.js");
// Mirrors agent.ts: only past-referring messages get a date range.
const ask = (m: string) => recall(m, refersToPast(m) ? resolveDate(m, now, IST) : null, "fresh-conversation");

test("a date in a normal question is not treated as memory", () => {
  assert.equal(memoryContext(ask("Was Python 3.13 released in March?"), IST), "");
});

test("3 November → the Cursor/Copilot exchange with its recorded facts", () => {
  const r = ask("What did I ask you on 3 November? Is your answer still correct today?");
  assert.equal(r.hits.length, 1);
  assert.match(r.hits[0].user.content, /Cursor/);
  assert.ok(r.hits[0].claims.some((c) => c.value === "$20/month"));
});

test("Monday CRM shortlist → five entities to re-check", () => {
  const r = ask("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?");
  assert.match(r.hits[0].user.content, /CRM/);
  assert.equal(memoryEntities(r).length, 5);
});

test("last Tuesday + topic → Postgres exchange", () => {
  const r = ask("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
  assert.match(r.hits[0].user.content, /Postgres/);
  assert.match(memoryContext(r, IST), /Neon · Launch plan price: from \$19\/month/);
});

test("a date with no conversation says so explicitly", () => {
  const r = ask("What did I ask you on 1 November?");
  assert.equal(r.hits.length, 0);
  assert.match(memoryContext(r, IST), /no past conversation found/);
});

test("topic recall without a date uses full-text search", () => {
  const r = ask("Earlier I asked you about Supabase, remember?");
  assert.match(r.hits[0]?.user.content ?? "", /Postgres/);
});

test("plain questions don't pull in memory", () => {
  assert.equal(memoryContext(ask("What's the weather in Tokyo?"), IST), "");
});
