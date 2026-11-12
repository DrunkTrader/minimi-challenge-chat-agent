import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

/**
 * Memory store. Built-in node:sqlite (no native install step) with FTS5 for
 * keyword recall. Time is a first-class column: every row has an ISO UTC time.
 */
export type Turn = {
  id: number; conversation_id: string; role: "user" | "assistant"; content: string;
  created_at: string; tz_offset: number; intent: string | null; entities: string | null;
};
export type Source = { id: number; turn_id: number; n: number; url: string; title: string; published_at: string | null; fetched_at: string; excerpt: string };
export type Claim = { id: number; turn_id: number; entity: string; attribute: string; value: string; source_url: string | null; observed_at: string };

let db: DatabaseSync | null = null;

export function getDb(path = config.dbPath): DatabaseSync {
  if (db) return db;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL, tz_offset INTEGER NOT NULL DEFAULT 0,
      intent TEXT, entities TEXT);
    CREATE INDEX IF NOT EXISTS turns_time ON turns(created_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(content, content='turns', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
      INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content); END;
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY, turn_id INTEGER NOT NULL, n INTEGER NOT NULL, url TEXT NOT NULL,
      title TEXT, published_at TEXT, fetched_at TEXT NOT NULL, excerpt TEXT);
    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY, turn_id INTEGER NOT NULL, entity TEXT NOT NULL, attribute TEXT NOT NULL,
      value TEXT NOT NULL, source_url TEXT, observed_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS claims_entity ON claims(entity);
    CREATE TABLE IF NOT EXISTS search_cache (
      key TEXT PRIMARY KEY, results TEXT NOT NULL, fetched_at TEXT NOT NULL);
  `);
  return db;
}

export function resetDb() { db?.close(); db = null; }

export function addTurn(t: Omit<Turn, "id">): number {
  const r = getDb().prepare(
    `INSERT INTO turns (conversation_id, role, content, created_at, tz_offset, intent, entities) VALUES (?,?,?,?,?,?,?)`
  ).run(t.conversation_id, t.role, t.content, t.created_at, t.tz_offset, t.intent, t.entities);
  return Number(r.lastInsertRowid);
}

export function addSources(turnId: number, sources: Omit<Source, "id" | "turn_id">[]) {
  const st = getDb().prepare(`INSERT INTO sources (turn_id, n, url, title, published_at, fetched_at, excerpt) VALUES (?,?,?,?,?,?,?)`);
  for (const s of sources) st.run(turnId, s.n, s.url, s.title, s.published_at, s.fetched_at, s.excerpt);
}

export function addClaims(turnId: number, claims: Omit<Claim, "id" | "turn_id">[]) {
  const st = getDb().prepare(`INSERT INTO claims (turn_id, entity, attribute, value, source_url, observed_at) VALUES (?,?,?,?,?,?)`);
  for (const c of claims) st.run(turnId, c.entity, c.attribute, c.value, c.source_url, c.observed_at);
}

export function setTurnEntities(turnId: number, entities: string[]) {
  getDb().prepare(`UPDATE turns SET entities = ? WHERE id = ?`).run(JSON.stringify(entities), turnId);
}

export const q = {
  turnsBetween: (startIso: string, endIso: string) =>
    getDb().prepare(`SELECT * FROM turns WHERE created_at >= ? AND created_at < ? ORDER BY created_at`).all(startIso, endIso) as Turn[],
  search: (match: string, limit = 6) =>
    getDb().prepare(`SELECT t.* FROM turns_fts f JOIN turns t ON t.id = f.rowid WHERE turns_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, limit) as Turn[],
  recent: (conversationId: string, limit = 8) =>
    (getDb().prepare(`SELECT * FROM turns WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`).all(conversationId, limit) as Turn[]).reverse(),
  answerFor: (userTurn: Turn) =>
    getDb().prepare(`SELECT * FROM turns WHERE conversation_id = ? AND role = 'assistant' AND id > ? ORDER BY id LIMIT 1`).get(userTurn.conversation_id, userTurn.id) as Turn | undefined,
  questionFor: (answer: Turn) =>
    getDb().prepare(`SELECT * FROM turns WHERE conversation_id = ? AND role = 'user' AND id < ? ORDER BY id DESC LIMIT 1`).get(answer.conversation_id, answer.id) as Turn | undefined,
  claimsFor: (turnIds: number[]) => turnIds.length
    ? getDb().prepare(`SELECT * FROM claims WHERE turn_id IN (${turnIds.map(() => "?").join(",")}) ORDER BY id`).all(...turnIds) as Claim[] : [],
  sourcesFor: (turnId: number) => getDb().prepare(`SELECT * FROM sources WHERE turn_id = ? ORDER BY n`).all(turnId) as Source[],
  conversations: () => getDb().prepare(
    `SELECT conversation_id, MIN(created_at) AS started, (SELECT content FROM turns t2 WHERE t2.conversation_id = t.conversation_id AND role='user' ORDER BY id LIMIT 1) AS title
     FROM turns t GROUP BY conversation_id ORDER BY started DESC LIMIT 50`).all() as { conversation_id: string; started: string; title: string }[],
  conversation: (id: string) => getDb().prepare(`SELECT * FROM turns WHERE conversation_id = ? ORDER BY id`).all(id) as Turn[],
  cacheGet: (key: string) => getDb().prepare(`SELECT * FROM search_cache WHERE key = ?`).get(key) as { results: string; fetched_at: string } | undefined,
  cachePut: (key: string, results: string, at: string) =>
    getDb().prepare(`INSERT OR REPLACE INTO search_cache (key, results, fetched_at) VALUES (?,?,?)`).run(key, results, at),
};
