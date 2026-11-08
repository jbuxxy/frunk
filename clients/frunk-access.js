// Frunk Access client: ask a Frunk server whether an email may sign in to your app.
// Copy this file into your app; it has no dependencies (Node 18+, global fetch).
//
//   const { createFrunkAccess } = require("./frunk-access");
//   const frunk = createFrunkAccess({ url: process.env.FRUNK_URL, key: process.env.FRUNK_ACCESS_KEY });
//   // In your Google sign-in, for an email you don't already know:
//   if (await frunk.allows(googleEmail)) { /* create their account */ }
//
// Answers are cached briefly. If Frunk can't be reached, or isn't set up, the answer is
// no (fails closed). The key comes from Frunk: People, App access. See
// docs/frunk-access.md in the Frunk repository.
const fs = require("node:fs");

function createFrunkAccess({ url = "", key = "", keyFile = "", cacheMs = 60_000, timeoutMs = 3000 } = {}) {
  if (!key && keyFile) { try { key = fs.readFileSync(keyFile, "utf8").trim(); } catch { key = ""; } }
  const base = String(url || "").replace(/\/+$/, "");
  const enabled = !!(base && key);
  const cache = new Map(); // email -> { at, allowed, name }

  async function check(email) {
    const e = String(email || "").trim().toLowerCase();
    if (!enabled || !e) return { allowed: false, name: null };
    const hit = cache.get(e);
    if (hit && Date.now() - hit.at < cacheMs) return hit;
    try {
      const res = await fetch(`${base}/api/access/check`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ email: e }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { allowed: false, name: null };
      const body = await res.json();
      const out = { at: Date.now(), allowed: body.allowed === true, name: typeof body.name === "string" ? body.name : null };
      cache.set(e, out);
      if (cache.size > 1000) cache.delete(cache.keys().next().value);
      return out;
    } catch {
      return { allowed: false, name: null };
    }
  }

  return { enabled, check, allows: async (email) => (await check(email)).allowed };
}

module.exports = { createFrunkAccess };
