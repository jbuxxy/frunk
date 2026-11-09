// Where accounts, connected apps and the default page are kept: a SQLite file in
// DATA_DIR (frunk.db, built into Node, nothing to set up), or Postgres when
// DATABASE_URL (or DATABASE_URL_FILE, a Docker secret) is set. See sql.js.
//
// Either way they're served from memory: what changed is written a moment later, a
// burst of changes as one write, only the rows that changed, in one transaction. The
// first start imports the JSON files older versions kept (and renames them *.imported).
const path = require("node:path");
const { databaseUrl, openDatabase } = require("./sql");

// A person's account in columns; data: what else Frunk keeps (tiles, connected apps…).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  admin boolean NOT NULL DEFAULT false,
  password text,
  google text,
  picture text,
  created timestamptz,
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sessions (
  hash text PRIMARY KEY,
  user_id text NOT NULL,
  expires bigint NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS invites (
  email text PRIMARY KEY,
  hash text NOT NULL UNIQUE,
  created timestamptz NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS access_apps (
  id text PRIMARY KEY,
  name text NOT NULL,
  origin text NOT NULL UNIQUE,
  key_hash text NOT NULL,
  created timestamptz NOT NULL,
  used timestamptz
);
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
`;

async function createDb({ dataDir, url = databaseUrl() }) {
  const db = await openDatabase({ url, file: path.join(dataDir, "frunk.db"), schema: SCHEMA });
  // What each row was when last written ("table|key" -> its values), so a write sends
  // only rows that changed, and deletes rows that are gone.
  const written = new Map();
  return {
    kind: db.kind,
    query: (text, params) => db.query(text, params),
    // Remember rows as the database has them now (after a read).
    remember(table, key, values) { written.set(`${table}|${key}`, JSON.stringify(values)); },
    // tables: { [table]: { key: column, rows: Map(key -> { column: value }) } }. Upserts
    // what changed and deletes what's gone, in one transaction.
    async sync(tables) {
      const changes = [];
      for (const [table, { key, rows }] of Object.entries(tables)) {
        for (const [k, values] of rows) {
          const json = JSON.stringify(values);
          if (written.get(`${table}|${k}`) !== json) changes.push({ table, key, k, values, json });
        }
        for (const id of written.keys()) {
          const [t, k] = [id.slice(0, id.indexOf("|")), id.slice(id.indexOf("|") + 1)];
          if (t === table && !rows.has(k)) changes.push({ table, key, k, values: null });
        }
      }
      if (!changes.length) return;
      await db.transaction(async (q) => {
        for (const { table, key, k, values } of changes) {
          if (!values) { await q(`DELETE FROM ${table} WHERE ${key} = $1`, [k]); continue; }
          const cols = Object.keys(values);
          const sets = cols.filter((c) => c !== key).map((c) => `${c} = EXCLUDED.${c}`).join(", ");
          await q(
            `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
             ON CONFLICT (${key}) DO ${sets ? `UPDATE SET ${sets}` : "NOTHING"}`,
            cols.map((c) => values[c]));
        }
      });
      for (const c of changes) {
        if (c.values) written.set(`${c.table}|${c.k}`, c.json);
        else written.delete(`${c.table}|${c.k}`);
      }
    },
    end: () => db.end(),
  };
}

// save() for a store: write() runs a moment later (a burst of changes as one write),
// retried in 30 s if it fails (memory still has everything); flush() writes now
// (before the process stops).
function laterWriter(write, label) {
  let timer = null, running = null, again = false;
  const run = async () => {
    timer = null;
    if (running) { again = true; return running; }
    running = write().catch((err) => {
      console.error(`[db] couldn't save ${label}: ${err.message}`);
      timer ||= setTimeout(run, 30_000);
    }).finally(() => {
      running = null;
      if (again) { again = false; timer ||= setTimeout(run, 0); }
    });
    return running;
  };
  return {
    save() { timer ||= setTimeout(run, 200); },
    async flush() { clearTimeout(timer); timer = null; if (running) await running; await run(); },
  };
}

module.exports = { createDb, laterWriter };
