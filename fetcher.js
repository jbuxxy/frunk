// Outbound fetches for user-supplied URLs (site icons, logo scans, previews).
// Private and local addresses are refused unless allowPrivate is set, so a
// signed-in user can't use Frunk to read services on the server's network.
// The check runs at DNS lookup time for every hop, so redirects and DNS tricks
// can't sneak past it.
//
// One exception: a public site that this network's own DNS sends to a LAN address
// (split DNS: example.com reaching your reverse proxy directly). If public DNS gives
// the name only public addresses, it's a public site, and over HTTPS the local route
// is fine: the certificate has to match the name, which a device on the network can't
// fake for someone else's domain (so a name that public DNS and this network's DNS
// answer differently on purpose gets nowhere). Plain HTTP to such a name is refused.
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const net = require("node:net");
const zlib = require("node:zlib");

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
]) blocked.addSubnet(addr, bits, "ipv4");
for (const [addr, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]]) {
  blocked.addSubnet(addr, bits, "ipv6");
}

function isPrivate(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

function blockedError(ip) {
  return Object.assign(new Error(`refusing to fetch private address ${ip}`), { code: "EPRIVATE" });
}

// Public DNS (DNS over HTTPS) for a name: true if it has addresses and all are public.
// Remembered for 10 minutes; false when public DNS can't be asked.
const PUBLIC_DNS = process.env.PUBLIC_DNS_URL || "https://cloudflare-dns.com/dns-query";
const publicNames = new Map(); // hostname -> { ok, at }
function publicInDns(hostname) {
  const hit = publicNames.get(hostname);
  if (hit && Date.now() - hit.at < 10 * 60_000) return Promise.resolve(hit.ok);
  const ask = (type) => new Promise((resolve) => {
    const req = https.get(`${PUBLIC_DNS}?name=${encodeURIComponent(hostname)}&type=${type}`, { headers: { accept: "application/dns-json" }, timeout: 4000 }, (res) => {
      let text = "";
      res.on("data", (c) => { if (text.length < 65536) text += c; });
      res.on("end", () => {
        try { resolve((JSON.parse(text).Answer || []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data)); } catch { resolve(null); }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
  return Promise.all([ask("A"), ask("AAAA")]).then(([a, aaaa]) => {
    const all = a && aaaa ? [...a, ...aaaa] : null;
    const ok = !!all && all.length > 0 && all.every((ip) => net.isIP(ip) && !isPrivate(ip));
    if (publicNames.size > 500) publicNames.clear();
    publicNames.set(hostname, { ok, at: Date.now() });
    return ok;
  });
}

// The lookup for a fetch: public addresses only, except a public HTTPS site this
// network routes privately (see the top).
function publicOnlyLookup(secure) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, async (err, addresses) => {
      if (err) return callback(err);
      const bad = addresses.find((a) => isPrivate(a.address));
      if (bad && !(secure && (await publicInDns(hostname)))) return callback(blockedError(bad.address));
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function request(url, { allowPrivate, headers, timeout, maxBytes }) {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && net.isIP(host) && isPrivate(host)) return reject(blockedError(host));
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, {
      headers: { "accept-encoding": "gzip, deflate, br", ...headers },
      lookup: allowPrivate ? undefined : publicOnlyLookup(url.protocol === "https:"),
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ status: res.statusCode, location: res.headers.location, headers: res.headers });
      }
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      const body = enc === "gzip" ? res.pipe(zlib.createGunzip())
        : enc === "deflate" ? res.pipe(zlib.createInflate())
        : enc === "br" ? res.pipe(zlib.createBrotliDecompress())
        : res;
      const chunks = [];
      let size = 0;
      body.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error("response too large"));
        } else chunks.push(c);
      });
      body.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      body.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

// GET a URL, following up to 5 redirects. Resolves to
// { ok, status, url (final), type (content-type without params), buf }.
async function get(rawUrl, { allowPrivate = false, headers = {}, timeout = 6000, maxBytes = 2 * 1024 * 1024 } = {}) {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= 5; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
    const res = await request(url, { allowPrivate, headers, timeout, maxBytes });
    if (res.location) {
      url = new URL(res.location, url);
      continue;
    }
    const type = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    return { ok: res.status >= 200 && res.status < 300, status: res.status, url: url.href, type, buf: res.buf };
  }
  throw new Error("too many redirects");
}

module.exports = { get, isPrivate, publicInDns };
