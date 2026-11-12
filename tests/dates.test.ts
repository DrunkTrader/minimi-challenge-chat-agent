import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDate, localDayStartUtc } from "../src/dates.js";

// Thursday 12 Nov 2026, 15:30 IST
const now = new Date("2026-11-12T10:00:00Z");
const IST = -330;
const day = (iso: string | undefined) => iso && new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

test("absolute date", () => {
  assert.equal(day(resolveDate("What did I ask you on 3 November?", now, IST)?.startIso), "2026-11-03");
});
test("last Tuesday", () => {
  assert.equal(day(resolveDate("Last Tuesday I asked you about Postgres hosting", now, IST)?.startIso), "2026-11-10");
});
test("weekday alone means the past one", () => {
  assert.equal(day(resolveDate("On Monday we shortlisted 5 CRM tools", now, IST)?.startIso), "2026-11-09");
});
test("since makes an open range to today", () => {
  const r = resolveDate("has anything changed since Monday?", now, IST)!;
  assert.equal(day(r.startIso), "2026-11-09");
  assert.equal(day(r.endIso), "2026-11-13");
});
test("no date", () => {
  assert.equal(resolveDate("what is the price of Neon?", now, IST), null);
});
test("local day start respects timezone", () => {
  assert.equal(localDayStartUtc(new Date("2026-11-12T20:00:00Z"), IST).toISOString(), "2026-11-12T18:30:00.000Z");
});
