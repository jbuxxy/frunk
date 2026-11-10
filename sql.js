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
        const q = (text, params) => client.query(text, params);
        q.query = q; // (called as q(…) or q.query(…))
        const out = await fn(q);
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

/** Column name -> type, from CREATE TABLE and ALTER TABLE … ADD COLUMN statements. */
function columnTypes(schema) {
  const types = new Map();
  const add = (name, type) => {
    if (!/^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)$/i.test(name)) types.set(name.toLowerCase(), type.toLowerCase());
  };
  for (const [, body] of schema.matchAll(/CREATE TABLE[^(]*\(([\s\S]*?)\n\s*\);/gi)) {
    for (const line of body.split("\n")) {
      const m = line.trim().match(/^([a-z_][a-z0-9_]*)\s+([a-z0-9]+)/i);
      if (m) add(m[1], m[2]);
    }
  }
  for (const m of schema.matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([a-z0-9]+)/gi)) add(m[1], m[2]);
  return types;
}

// What SQLite can't run as written:
//   $1 -> ?1; now() -> the current time as an ISO string (as stored here); ::type casts
//   dropped; bigserial/serial keys -> SQLite's own; x = ANY($1) (an array) -> x IN (the
//   array, sent as JSON).
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function toSqlite(text) {
  return text
    .replace(/\$(\d+)/g, "?$1")
    .replace(/DEFAULT\s+now\(\)/gi, `DEFAULT (${NOW_SQL})`)
    .replace(/\bnow\(\)/gi, NOW_SQL)
    .replace(/::[a-z_]+(\[\])?/gi, "")
    .replace(/=\s*ANY\(\s*\?(\d+)\s*\)/gi, "IN (SELECT value FROM json_each(?$1))")
    .replace(/\b(big)?serial\s+PRIMARY KEY/gi, "INTEGER PRIMARY KEY AUTOINCREMENT");
}

// The schema, one statement at a time. Postgres schemas grow with ALTER TABLE … ADD COLUMN
// IF NOT EXISTS, which SQLite doesn't have (nor can it add a UNIQUE column, or one that
// defaults to the time). So a table made here gets those columns in its CREATE TABLE, and
// on an existing table a missing one is added plainly, with a unique index or its default
// filled in.
const ADD_COLUMN = /^ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+ADD COLUMN\s+IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s+([\s\S]*)$/i;
function applySchema(db, schema) {
  const statements = toSqlite(schema).split(/;\s*(?:\n|$)/).map((raw) => raw.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  const added = new Map(); // table -> [column definitions from ALTER TABLE … ADD COLUMN]
  for (const st of statements) {
    const m = st.match(ADD_COLUMN);
    if (m) (added.get(m[1].toLowerCase()) || added.set(m[1].toLowerCase(), []).get(m[1].toLowerCase())).push(`${m[2]} ${m[3]}`);
  }
  const exists = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const hasColumn = (table, column) => !!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column);
  for (const st of statements) {
    const add = st.match(ADD_COLUMN);
    if (add) {
      const [, table, column, rest] = add;
      if (hasColumn(table, column)) continue;
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${rest}`);
      } catch {
        const type = rest.match(/^[a-z0-9_]+/i)?.[0] || "";
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        if (/\bUNIQUE\b/i.test(rest)) db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_${column}_unique ON ${table} (${column})`);
        const def = rest.match(/\bDEFAULT\s+(\([^)]*\)\)?|'[^']*'|[^\s,]+)/i)?.[1];
        if (def) db.exec(`UPDATE ${table} SET ${column} = ${def} WHERE ${column} IS NULL`);
      }
      continue;
    }
    const create = st.match(/^CREATE TABLE\s+IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*)\)\s*$/i);
    if (create && added.has(create[1].toLowerCase()) && !exists(create[1])) {
      const body = create[2].trimEnd();
      // Columns before any table constraint (PRIMARY KEY (…), UNIQUE (…)…), as SQLite needs.
      const parts = body.split(/,\s*\n/);
      const firstConstraint = parts.findIndex((p) => /^\s*(PRIMARY KEY|UNIQUE|CONSTRAINT|FOREIGN KEY|CHECK)\s*\(/i.test(p));
      const cols = added.get(create[1].toLowerCase());
      if (firstConstraint < 0) parts.push(...cols);
      else parts.splice(firstConstraint, 0, ...cols);
      db.exec(`CREATE TABLE IF NOT EXISTS ${create[1]} (\n${parts.join(",\n")}\n)`);
      continue;
    }
    db.exec(st);
  }
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
  applySchema(db, schema);
  const types = columnTypes(schema);
  // Each result column's type: as declared on the table it comes from (so "extra AS
  // prefs_extra" still reads as JSON), else by its name.
  const typesOf = (st) => {
    let cols = [];
    try { cols = st.columns(); } catch {}
    const out = new Map();
    for (const c of cols) out.set(c.name, String(c.type || "").toLowerCase().split("(")[0] || types.get(c.name.toLowerCase()));
    return out;
  };
  const decode = (row, colTypes) => {
    for (const [col, v] of Object.entries(row)) {
      if (v === null) continue;
      const type = colTypes.get(col) || types.get(col.toLowerCase());
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
      st.colTypes = typesOf(st);
      statements.set(text, st);
      if (statements.size > 500) statements.delete(statements.keys().next().value);
    }
    return st;
  };
  const run = (text, params = []) => {
    const st = prepare(text);
    const args = params.map(bindValue);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(text) || /\bRETURNING\b/i.test(text)) {
      const rows = st.all(...args).map((r) => decode({ ...r }, st.colTypes));
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
        const q = async (text, params) => run(text, params);
        q.query = q; // (called as q(…) or, like a pg client, q.query(…))
        const out = await fn(q);
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

module.exports = { databaseUrl, openDatabase, toSqlite, columnTypes, applySchema };
