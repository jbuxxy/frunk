// Optional Postgres. With DATABASE_URL (or DATABASE_URL_FILE, a Docker secret) set,
// accounts, connected apps and the default page are kept in Postgres; without it, in
// JSON files under DATA_DIR as always (no database needed to run Frunk).
//
// Either way they're served from memory: what changed is written a moment later, a
// burst of changes as one write. With Postgres that's only the rows that changed, in
// one transaction. The first start with Postgres imports the JSON files (and renames
// them *.imported).
const fs = require("node:fs");

function connectionString() {
  if (process.env.DATABASE_URL_FILE) return fs.readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim();
  return process.env.DATABASE_URL || null;
}

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

// null without a database configured.
async function createPg() {
  const url = connectionString();
  if (!url) return null;
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30_000 });
  pool.on("error", (err) => console.warn(`[pg] ${err.message}`));
  // The database may still be starting when the container comes up.
  for (let attempt = 1; ; attempt++) {
    try { await pool.query(SCHEMA); break; } catch (err) {
      if (attempt >= 15) throw err;
      console.warn(`[pg] waiting for Postgres (${err.message})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  // What each row was when last written ("table|key" -> its values), so a write sends
  // only rows that changed, and deletes rows that are gone.
  const written = new Map();
  return {
    query: (text, params) => pool.query(text, params),
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
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const { table, key, k, values } of changes) {
          if (!values) { await client.query(`DELETE FROM ${table} WHERE ${key} = $1`, [k]); continue; }
          const cols = Object.keys(values);
          const sets = cols.filter((c) => c !== key).map((c) => `${c} = EXCLUDED.${c}`).join(", ");
          await client.query(
            `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
             ON CONFLICT (${key}) DO ${sets ? `UPDATE SET ${sets}` : "NOTHING"}`,
            cols.map((c) => values[c]));
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      for (const c of changes) {
        if (c.values) written.set(`${c.table}|${c.k}`, c.json);
        else written.delete(`${c.table}|${c.k}`);
      }
    },
    end: () => pool.end(),
  };
}

// save() for a store: with Postgres, write() runs a moment later (a burst of changes as
// one write), retried in 30 s if it fails (memory still has everything); flush() writes
// now (before the process stops).
function laterWriter(write, label) {
  let timer = null, running = null, again = false;
  const run = async () => {
    timer = null;
    if (running) { again = true; return running; }
    running = write().catch((err) => {
      console.error(`[pg] couldn't save ${label}: ${err.message}`);
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

module.exports = { createPg, laterWriter };
