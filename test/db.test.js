// The database layer: the same code on SQLite (the default) and on Postgres (run with
// TEST_DATABASE_URL set to an empty, throwaway database to test that too).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDb } = require("../db");
const { createAccounts } = require("../accounts");
const { createAccess } = require("../access");

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "frunk-db-"));
const drivers = [["SQLite", null], ...(process.env.TEST_DATABASE_URL ? [["Postgres", process.env.TEST_DATABASE_URL]] : [])];

for (const [name, url] of drivers) {
  test(`${name}: values come back as they went in`, async (t) => {
    const store = await createDb({ dataDir: dir(), url });
    t.after(() => store.end());
    if (url) await store.query("DELETE FROM users");
    const created = new Date("2026-11-09T12:34:56.789Z");
    await store.sync({ users: { key: "id", rows: new Map([["u1", {
      id: "u1", email: "a@example.com", name: null, admin: true, password: null, google: "g", picture: null, created, data: { tiles: [{ name: "TV" }], n: 3 },
    }]]) } });
    const { rows } = await store.query("SELECT * FROM users WHERE email = $1 AND id = $2", ["a@example.com", "u1"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].admin, true);
    assert.equal(rows[0].name, null);
    assert.ok(rows[0].created instanceof Date);
    assert.equal(rows[0].created.toISOString(), created.toISOString());
    assert.deepEqual(rows[0].data, { tiles: [{ name: "TV" }], n: 3 });
    // Only what changed is written; a row that's gone is deleted.
    await store.sync({ users: { key: "id", rows: new Map() } });
    assert.equal((await store.query("SELECT * FROM users")).rows.length, 0);
  });

  test(`${name}: arrays with ANY(), and columns under another name`, async (t) => {
    const store = await createDb({ dataDir: dir(), url });
    t.after(() => store.end());
    if (url) await store.query("DELETE FROM settings");
    for (const k of ["a", "b", "c"]) await store.query("INSERT INTO settings (key, value) VALUES ($1, $2)", [k, { k }]);
    await store.query("DELETE FROM settings WHERE NOT (key = ANY($1::text[]))", [["a", "c"]]);
    const { rows } = await store.query("SELECT key, value AS v, count(*) OVER ()::int AS n FROM settings ORDER BY key");
    assert.deepEqual(rows.map((r) => [r.key, r.v, Number(r.n)]), [["a", { k: "a" }, 2], ["c", { k: "c" }, 2]]);
  });

  test(`${name}: a failed transaction leaves nothing behind`, async (t) => {
    const store = await createDb({ dataDir: dir(), url });
    t.after(() => store.end());
    if (url) await store.query("DELETE FROM settings");
    await assert.rejects(store.sync({ settings: { key: "key", rows: new Map([["a", { key: "a", value: { ok: 1 } }], ["b", { key: "b", value: null }]]) } }));
    assert.equal((await store.query("SELECT * FROM settings")).rows.length, 0);
  });
}

test("SQLite: an older version's JSON files are imported once, then renamed", async () => {
  const d = dir();
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({
    users: [{ id: "u1", email: "owner@example.com", name: "Owner", admin: true, created: "2026-01-01T00:00:00.000Z", sites: [{ name: "TV", url: "https://tv.example.com" }] }],
    invites: [{ email: "friend@example.com", token: "old-plain-token", created: new Date().toISOString() }],
    sessions: { abc: { userId: "u1", expires: Date.now() + 86_400_000 } },
  }));
  fs.writeFileSync(path.join(d, "access.json"), JSON.stringify({ apps: [{ id: "a1", name: "TV", origin: "https://tv.example.com", keyHash: "h", created: "2026-01-03T00:00:00.000Z" }] }));
  let store = await createDb({ dataDir: d, url: null });
  let accounts = createAccounts({ dataDir: d, ownerEmail: "owner@example.com", store });
  let access = createAccess({ dataDir: d, store });
  await Promise.all([accounts.load(), access.load()]);
  await Promise.all([accounts.flush(), access.flush()]);
  assert.ok(fs.existsSync(path.join(d, "accounts.json.imported")));
  assert.ok(fs.existsSync(path.join(d, "access.json.imported")));
  assert.ok(!fs.existsSync(path.join(d, "accounts.json")));
  await store.end();

  // A restart reads it all back from the database.
  store = await createDb({ dataDir: d, url: null });
  accounts = createAccounts({ dataDir: d, ownerEmail: "owner@example.com", store });
  access = createAccess({ dataDir: d, store });
  await Promise.all([accounts.load(), access.load()]);
  const owner = accounts.byEmail("owner@example.com");
  assert.equal(owner.name, "Owner");
  assert.equal(owner.sites[0].url, "https://tv.example.com");
  assert.equal(access.list().length, 1);
  // The old plain invite token still works (now kept as its hash).
  assert.ok(accounts.findInvite("old-plain-token"));
  await store.end();
});
