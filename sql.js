// One database API over two drivers: Postgres (the `pg` package) when a connection
// string is set, else SQLite built into Node (node:sqlite, a file in the data folder).
// The app writes Postgres SQL; for SQLite this translates the little that differs:
//   - $1, $2… parameters (SQLite's ?1, ?2…)
//   - now() (the current time, as an ISO string)
//   - values: true/false, Dates and objects (JSON) in, and back out as the column's
//     type says (boolean, timestamptz, json/jsonb, bigint), the way pg returns them
// Column types come from the CREATE TABLE statements passed as `schema`.
//
// The same file is used by each app (BuxTV, CoDrive, Buxxy's Arcade, Frunk, FSP), copied
// by hand like frunk-access.js: change it in one, copy it to the others.
//
//   const db = await openDatabase({ url, file, schema })
//   await db.query("SELECT * FROM users WHERE id = $1", [id])  // -> { rows, rowCount }
//   await db.transaction(async (q) => { await q("…", […]); })
//   db.kind  // "postgres" | "sqlite"
const fs = require("node:fs");
const path = require("node:path");

/** DATABASE_URL, or the contents of DATABASE_URL_FILE (a Docker secret); null if neither. */
function databaseUrl(env = process.env) {
  if (env.DATABASE_URL_FILE) return fs.readFileSync(env.DATABASE_URL_FILE, "utf8").trim();
  return env.DATABASE_URL || null;
}

async function openDatabase({ url, file, schema, label = "db" }) {
  return url ? openPostgres(url, schema, label) : openSqlite(file, schema);
}

async function openPostgres(url, schema, label) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30_000 });
  pool.on("error", (err) => console.warn(`[${label}] ${err.message}`));
  // The database may still be starting when the container comes up.
  for (let attempt = 1; ; attempt++) {
    try { await pool.query(schema); break; } catch (err) {
      if (attempt >= 15) throw err;
      console.warn(`[${label}] waiting for Postgres (${err.message})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return {
    kind: "postgres",
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn((text, params) => client.query(text, params));
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

// node:sqlite still prints an "experimental" warning on first use; it's stable enough for this.
function quietSqliteWarning() {
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (/SQLite is an experimental feature/.test(text || "")) return;
    return emit.call(this, warning, ...rest);
  };
}

/** Column name -> type, from CREATE TABLE statements. */
function columnTypes(schema) {
  const types = new Map();
  for (const [, body] of schema.matchAll(/CREATE TABLE[^(]*\(([\s\S]*?)\n\s*\);/gi)) {
    for (const line of body.split("\n")) {
      const m = line.trim().match(/^([a-z_][a-z0-9_]*)\s+([a-z]+)/i);
      if (m && !/^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)$/i.test(m[1])) types.set(m[1].toLowerCase(), m[2].toLowerCase());
    }
  }
  return types;
}

// What SQLite can't run as written. DEFAULT now() becomes the current time as an ISO
// string (as stored by this file), and now() in queries likewise.
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function toSqlite(text) {
  return text
    .replace(/\$(\d+)/g, "?$1")
    .replace(/DEFAULT\s+now\(\)/gi, `DEFAULT (${NOW_SQL})`)
    .replace(/\bnow\(\)/gi, NOW_SQL);
}

function bindValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) return v;
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

function openSqlite(file, schema) {
  quietSqliteWarning();
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  try { fs.chmodSync(file, 0o600); } catch {}
  db.exec(toSqlite(schema));
  const types = columnTypes(schema);
  const decode = (row) => {
    for (const [col, v] of Object.entries(row)) {
      if (v === null) continue;
      const type = types.get(col.toLowerCase());
      if (type === "boolean" || type === "bool") row[col] = !!v;
      else if ((type === "jsonb" || type === "json") && typeof v === "string") { try { row[col] = JSON.parse(v); } catch {} }
      else if (type === "timestamptz" || type === "timestamp") row[col] = new Date(typeof v === "number" ? v : String(v));
      else if (type === "bigint" || type === "int8") row[col] = String(v); // as pg returns it
    }
    return row;
  };
  const statements = new Map();
  const prepare = (text) => {
    let st = statements.get(text);
    if (!st) {
      st = db.prepare(toSqlite(text));
      statements.set(text, st);
      if (statements.size > 500) statements.delete(statements.keys().next().value);
    }
    return st;
  };
  const run = (text, params = []) => {
    const st = prepare(text);
    const args = params.map(bindValue);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(text) || /\bRETURNING\b/i.test(text)) {
      const rows = st.all(...args).map((r) => decode({ ...r }));
      return { rows, rowCount: rows.length };
    }
    const info = st.run(...args);
    return { rows: [], rowCount: Number(info.changes) };
  };
  // One at a time: SQLite has one writer, and statements here run synchronously anyway.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  return {
    kind: "sqlite",
    file,
    query: (text, params) => serial(() => run(text, params)),
    transaction: (fn) => serial(async () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = await fn(async (text, params) => run(text, params));
        db.exec("COMMIT");
        return out;
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch {}
        throw err;
      }
    }),
    async end() { await chain; db.close(); },
  };
}

module.exports = { databaseUrl, openDatabase, toSqlite, columnTypes };
