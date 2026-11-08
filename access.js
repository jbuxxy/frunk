// Frunk Access: Frunk as the front door for your other apps.
//
// An admin connects an app (its name and address) and gets an app key, shown once. The
// app then asks Frunk, with that key, whether an email may sign in:
//
//   POST /api/access/check   Authorization: Bearer <app key>   { "email": "..." }
//   -> { "allowed": true|false, "name": "Their name" }
//
// Allowed means: someone with that email has a tile for the app's address on their
// Frunk page that an admin gave them (the default page, an invite, or Send tile). A tile
// someone added themselves, or edited to point elsewhere, never counts. Each app is its
// own grant: a BuxTV tile opens BuxTV, nothing else. See docs/frunk-access.md.
//
// Stored in DATA_DIR/access.json: apps and the SHA-256 of their keys (never the keys).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// "https://BuxTV.example.com/some/page" -> "https://buxtv.example.com"
function originOf(u) {
  try {
    const url = new URL(String(u).trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function createAccess({ dataDir }) {
  const FILE = path.join(dataDir, "access.json");
  let db = { apps: [] };
  try { db = { apps: [], ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch (err) { if (err.code !== "ENOENT") throw err; }
  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  };
  const newKey = () => `fa_${crypto.randomBytes(32).toString("base64url")}`;
  const view = (a) => ({ id: a.id, name: a.name, origin: a.origin, created: a.created, used: a.used || null });

  function list() { return db.apps.map(view); }

  // A new connected app -> { app, key } (the key is only ever shown here).
  function add(name, address) {
    const origin = originOf(address);
    name = String(name || "").trim().slice(0, 40);
    if (!origin) return { error: "Enter the app's address, like https://tv.example.com." };
    if (!name) return { error: "Give it a name." };
    if (db.apps.some((a) => a.origin === origin)) return { error: "That address is already connected." };
    const key = newKey();
    const app = { id: crypto.randomUUID(), name, origin, keyHash: sha(key), created: new Date().toISOString() };
    db.apps.push(app);
    save();
    return { app: view(app), key };
  }
  function rekey(id) {
    const app = db.apps.find((a) => a.id === id);
    if (!app) return null;
    const key = newKey();
    app.keyHash = sha(key);
    save();
    return { app: view(app), key };
  }
  function rename(id, name) {
    const app = db.apps.find((a) => a.id === id);
    name = String(name || "").trim().slice(0, 40);
    if (!app || !name) return null;
    app.name = name;
    save();
    return view(app);
  }
  function remove(id) {
    const before = db.apps.length;
    db.apps = db.apps.filter((a) => a.id !== id);
    if (db.apps.length !== before) save();
    return db.apps.length !== before;
  }

  // The app a key belongs to (compared by hash, in constant time), or null.
  function appForKey(key) {
    if (typeof key !== "string" || !key.startsWith("fa_") || key.length > 100) return null;
    const want = Buffer.from(sha(key), "hex");
    let found = null;
    for (const a of db.apps) {
      if (crypto.timingSafeEqual(Buffer.from(a.keyHash, "hex"), want)) found = a;
    }
    return found;
  }

  // May this email sign in to this app? users: Frunk's accounts.
  function check(app, email, users) {
    const e = String(email || "").trim().toLowerCase();
    const user = users.find((u) => u.email === e);
    const allowed = !!user && (user.sites || []).some((s) => s.grant && originOf(s.url) === app.origin);
    if (allowed) {
      app.used = new Date().toISOString();
      save();
    }
    return { allowed, name: allowed ? user.name : null };
  }

  // How many people each app is granted to (for the admin's list).
  function counts(users) {
    const out = {};
    for (const a of db.apps) out[a.id] = users.filter((u) => (u.sites || []).some((s) => s.grant && originOf(s.url) === a.origin)).length;
    return out;
  }

  return { list, add, rekey, rename, remove, appForKey, check, counts };
}

module.exports = { createAccess, originOf };
