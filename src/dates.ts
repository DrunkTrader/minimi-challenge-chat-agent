import * as chrono from "chrono-node";

/**
 * Turns "last Tuesday", "on Monday", "3 November", "since yesterday" into an absolute
 * local-day range, in code, not in the LLM. tzOffset is JS getTimezoneOffset() minutes
 * (e.g. IST = -330). Memory questions are about the past, so a weekday that lands in
 * the future is moved back a week.
 */
export type DateRange = { startIso: string; endIso: string; label: string; text: string };

const DAY = 86_400_000;

export function localDayStartUtc(instant: Date, tzOffset: number): Date {
  const localMs = instant.getTime() - tzOffset * 60_000;
  const dayStartLocal = Math.floor(localMs / DAY) * DAY;
  return new Date(dayStartLocal + tzOffset * 60_000);
}

export function formatLocal(iso: string | Date, tzOffset: number, withTime = false): string {
  const d = new Date(new Date(iso).getTime() - tzOffset * 60_000);
  const opts: Intl.DateTimeFormatOptions = { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" };
  if (withTime) Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString("en-GB", opts);
}

export function resolveDate(text: string, now: Date, tzOffset: number): DateRange | null {
  const results = chrono.en.GB.parse(text, { instant: now, timezone: -tzOffset }, { forwardDate: false });
  // Ignore bare times ("at 5") and numbers chrono over-reads; we only care about days.
  const r = results.find((x) => x.start.isCertain("day") || x.start.isCertain("weekday"));
  if (!r) return null;
  let day = localDayStartUtc(r.start.date(), tzOffset);
  const today = localDayStartUtc(now, tzOffset);
  if (day.getTime() > today.getTime()) {
    // "Monday" said on a Sunday means the past Monday; "3 November" said in October means last year.
    day = r.start.isCertain("month") ? new Date(Date.UTC(day.getUTCFullYear() - 1, day.getUTCMonth(), day.getUTCDate()) + (day.getTime() % DAY)) : new Date(day.getTime() - 7 * DAY);
  }
  const isRange = /\bsince\b/i.test(text.slice(Math.max(0, r.index - 8), r.index + 1));
  const end = isRange ? new Date(today.getTime() + DAY) : new Date(day.getTime() + DAY);
  return { startIso: day.toISOString(), endIso: end.toISOString(), label: formatLocal(day, tzOffset), text: r.text };
}
