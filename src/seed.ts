import { clock } from "./config.js";
import { getDb, addTurn, addSources, addClaims } from "./db.js";
import { localDayStartUtc } from "./dates.js";

/**
 * Backdated demo history so reviewers can ask "what did I ask on 3 November?" or
 * "last Tuesday…" right away instead of waiting a week. Values are illustrative,
 * recorded "as of" their date. That is exactly what re-checking is for.
 */
const DAY = 86_400_000;

function pastWeekday(now: Date, tz: number, weekday: number) {
  const today = localDayStartUtc(now, tz);
  const localDow = new Date(today.getTime() - tz * 60_000).getUTCDay();
  const back = ((localDow - weekday + 7) % 7) || 7;
  return new Date(today.getTime() - back * DAY);
}
const at = (day: Date, hour: number, min = 0) => new Date(day.getTime() + (hour * 60 + min) * 60_000).toISOString();

type Demo = {
  day: Date; hour: number; question: string; answer: string; entities: string[];
  facts: [entity: string, attribute: string, value: string, url: string][];
};

export function demoHistory(now = clock.now(), tz = now.getTimezoneOffset()): Demo[] {
  const today = localDayStartUtc(now, tz);
  const nov3Local = Date.UTC(now.getUTCFullYear(), 10, 3);
  let nov3 = new Date(nov3Local + tz * 60_000);
  if (nov3.getTime() >= today.getTime()) nov3 = new Date(Date.UTC(now.getUTCFullYear() - 1, 10, 3) + tz * 60_000);

  const demos: Demo[] = [
    {
      day: nov3, hour: 11,
      question: "How much do Cursor Pro and GitHub Copilot Pro cost per month for one developer?",
      answer: "As of early Nov: **Cursor Pro** is $20/month [1] and **GitHub Copilot Pro** is $10/month [2]. Copilot also has a free tier with limited completions [2].",
      entities: ["Cursor", "GitHub Copilot"],
      facts: [
        ["Cursor", "Pro plan price", "$20/month", "https://cursor.com/pricing"],
        ["GitHub Copilot", "Pro plan price", "$10/month", "https://github.com/features/copilot/plans"],
      ],
    },
    {
      day: pastWeekday(now, tz, 1), hour: 10,
      question: "We're a 20-person sales team. Shortlist 5 CRM tools for us with per-seat pricing.",
      answer: "Shortlist (per seat, billed annually):\n\n| CRM | Plan | Price |\n|---|---|---|\n| HubSpot Sales Hub | Professional | $90/seat/mo [1] |\n| Pipedrive | Growth | $49/seat/mo [2] |\n| Salesforce Sales Cloud | Pro Suite | $100/seat/mo [3] |\n| Zoho CRM | Professional | $40/seat/mo [4] |\n| Freshsales | Pro | $47/seat/mo [5] |\n\nFor 20 reps, Zoho and Freshsales are cheapest; HubSpot has the strongest marketing integration.",
      entities: ["HubSpot Sales Hub", "Pipedrive", "Salesforce Sales Cloud", "Zoho CRM", "Freshsales"],
      facts: [
        ["HubSpot Sales Hub", "Professional price", "$90/seat/month", "https://www.hubspot.com/pricing/sales"],
        ["Pipedrive", "Growth price", "$49/seat/month", "https://www.pipedrive.com/en/pricing"],
        ["Salesforce Sales Cloud", "Pro Suite price", "$100/seat/month", "https://www.salesforce.com/sales/pricing/"],
        ["Zoho CRM", "Professional price", "$40/seat/month", "https://www.zoho.com/crm/zohocrm-pricing.html"],
        ["Freshsales", "Pro price", "$47/seat/month", "https://www.freshworks.com/crm/pricing/"],
      ],
    },
    {
      day: pastWeekday(now, tz, 2), hour: 16,
      question: "What are good managed Postgres hosting options for a small SaaS, and what do they cost?",
      answer: "Good options for a small SaaS:\n\n- **Neon**: serverless Postgres, Launch plan from $19/month [1]\n- **Supabase**: Pro plan $25/month per project, includes auth and storage [2]\n- **Render**: managed Postgres from $6/month (Basic) [3]\n\nNeon is cheapest to start if your load is spiky; Supabase if you also want auth.",
      entities: ["Neon", "Supabase", "Render"],
      facts: [
        ["Neon", "Launch plan price", "from $19/month", "https://neon.com/pricing"],
        ["Supabase", "Pro plan price", "$25/month per project", "https://supabase.com/pricing"],
        ["Render", "Postgres Basic price", "from $6/month", "https://render.com/pricing"],
      ],
    },
  ];
  return demos.filter((d) => d.day.getTime() < today.getTime());
}

export function seedDemo(now = clock.now(), tz = now.getTimezoneOffset()) {
  const db = getDb();
  const demoIds = (db.prepare(`SELECT id FROM turns WHERE conversation_id LIKE 'demo-%'`).all() as { id: number }[]).map((r) => r.id);
  if (demoIds.length) {
    const list = demoIds.join(",");
    db.exec(`DELETE FROM claims WHERE turn_id IN (${list}); DELETE FROM sources WHERE turn_id IN (${list}); DELETE FROM turns WHERE id IN (${list}); INSERT INTO turns_fts(turns_fts) VALUES('rebuild');`);
  }
  const demos = demoHistory(now, tz);
  demos.forEach((d, i) => {
    const conv = `demo-${i + 1}`;
    const asked = at(d.day, d.hour), answered = at(d.day, d.hour, 1);
    addTurn({ conversation_id: conv, role: "user", content: d.question, created_at: asked, tz_offset: tz, intent: "search", entities: JSON.stringify(d.entities) });
    const aid = addTurn({ conversation_id: conv, role: "assistant", content: d.answer, created_at: answered, tz_offset: tz, intent: "search", entities: null });
    addSources(aid, d.facts.map((f, n) => ({ n: n + 1, url: f[3], title: `${f[0]} pricing`, published_at: null, fetched_at: answered, excerpt: `${f[1]}: ${f[2]}` })));
    addClaims(aid, d.facts.map((f) => ({ entity: f[0], attribute: f[1], value: f[2], source_url: f[3], observed_at: answered })));
  });
  return demos.length;
}

export function isEmpty() {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number }).n === 0;
}
