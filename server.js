// Frunk — tiny zero-dependency server: static files + a JSON site list.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");

const { createAccounts, SESSION_DAYS } = require("./accounts");
const { createMailer } = require("./mailer");
const fetcher = require("./fetcher");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
// The public default page (what signed-out visitors see; new accounts start from a copy).
const SITES_FILE = path.join(DATA_DIR, "default.json");
const PUBLIC_URL = (process.env.FRUNK_PUBLIC_URL || "").replace(/\/$/, "");
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const PUBLIC_DIR = path.join(__dirname, "public");
// Reverse proxies (IPs or CIDRs, comma-separated) whose X-Forwarded-*/X-Real-IP
// headers are believed. Anyone else could fake those headers.
const TRUSTED_PROXIES = new net.BlockList();
for (const entry of (process.env.TRUSTED_PROXIES || "127.0.0.1,::1").split(",").map((x) => x.trim()).filter(Boolean)) {
  const [addr, bits] = entry.split("/");
  const type = net.isIP(addr) === 6 ? "ipv6" : "ipv4";
  if (bits) TRUSTED_PROXIES.addSubnet(addr, Number(bits), type);
  else TRUSTED_PROXIES.addAddress(addr, type);
}
// Changes every server start (i.e. every deploy), so browsers never keep stale CSS/JS.
const ASSET_VERSION = Date.now().toString(36);

// Generic starter page: what signed-out visitors see and what new accounts start with.
const SEED = [
  { name: "YouTube", url: "https://www.youtube.com" },
  { name: "Netflix", url: "https://www.netflix.com" },
  { name: "Disney+", url: "https://www.disneyplus.com" },
  { name: "Prime Video", url: "https://www.primevideo.com" },
  { name: "HBO Max", url: "https://play.hbomax.com" },
  { name: "Hulu", url: "https://www.hulu.com" },
  { name: "Spotify", url: "https://open.spotify.com" },
  { name: "YouTube Music", url: "https://music.youtube.com" },
  { name: "Twitch", url: "https://www.twitch.tv" },
].map((s) => ({ id: crypto.randomUUID(), ...s }));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

// Only this process writes the file, so its text is kept in memory. Parsed on
// each read so callers always get their own copy.
let sitesText = null;
function readSites() {
  if (sitesText === null) {
    try {
      sitesText = fs.readFileSync(SITES_FILE, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      writeSites(SEED);
    }
  }
  return JSON.parse(sitesText);
}

function writeSites(sites) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const text = JSON.stringify(sites, null, 2);
  const tmp = `${SITES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, SITES_FILE);
  sitesText = text;
}

function validSites(body) {
  if (!Array.isArray(body) || body.length > 200) return null;
  const out = [];
  for (const s of body) {
    if (!s || typeof s.name !== "string" || typeof s.url !== "string") return null;
    let url;
    try {
      url = new URL(s.url);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    out.push({
      id: typeof s.id === "string" && s.id ? s.id : crypto.randomUUID(),
      name: s.name.trim().slice(0, 40) || url.hostname,
      url: url.href,
      color: /^#[0-9a-f]{6}$/i.test(s.color || "") ? s.color : undefined,
      icon: typeof s.icon === "string" && /^https?:\/\//i.test(s.icon.trim()) ? s.icon.trim() : undefined,
      logo: typeof s.logo === "string" && /^(di:[a-z0-9-]{1,80}|[a-z0-9]{1,60}|none)$/.test(s.logo) ? s.logo : undefined,
    });
  }
  return out;
}

// ---------- Icons ----------
// Fetched by the server (on the LAN, so it can see private services that
// Google's favicon service can't), then cached in memory + on disk.
const ICON_DIR = path.join(DATA_DIR, "icons");
const iconCache = new Map(); // key -> { type, buf } | null (known miss)
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

// allowPrivate: may reach addresses on the server's own network (admins only).
async function fetchImage(url, allowPrivate) {
  const res = await fetcher.get(url, { allowPrivate, headers: { "user-agent": UA } });
  if (!res.ok || !(res.type.startsWith("image/") || res.type === "application/octet-stream")) return null;
  if (res.buf.length < 100) return null;
  return { type: res.type.startsWith("image/") ? res.type : "image/x-icon", buf: res.buf };
}

// Icons a page advertises (best first) plus <img> tags that look like logos.
async function scanPage(siteUrl, allowPrivate) {
  const res = await fetcher.get(siteUrl, { allowPrivate, headers: { "user-agent": UA }, maxBytes: 1024 * 1024 }).catch((err) => {
    if (err.code === "EPRIVATE") throw err;
    return { url: siteUrl, buf: Buffer.alloc(0) }; // too big or unreachable: still try the usual icon paths
  });
  const html = res.buf.toString("utf8").slice(0, 300_000);
  const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i")) || [])[1];
  const links = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = attr(tag, "rel")?.toLowerCase() || "";
    const href = attr(tag, "href");
    if (!href || !/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)(\s|$)/.test(rel)) continue;
    const size = Number((attr(tag, "sizes") || "").split("x")[0]) || 0;
    const score = (rel.includes("apple-touch") ? 1000 : 0) + (href.endsWith(".svg") ? 900 : 0) + size - (rel === "mask-icon" ? 2000 : 0);
    links.push({ url: new URL(href, res.url).href, score });
  }
  links.sort((a, b) => b.score - a.score);
  const logos = [];
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const src = attr(tag, "src");
    if (!src || src.startsWith("data:")) continue;
    if (/logo|brand|wordmark/i.test(`${src} ${attr(tag, "alt") || ""} ${attr(tag, "class") || ""} ${attr(tag, "id") || ""}`)) {
      logos.push(new URL(src, res.url).href);
    }
  }
  return { finalUrl: res.url, icons: links.map((l) => l.url), logos };
}

async function iconCandidates(siteUrl, allowPrivate) {
  const out = [];
  try {
    const { finalUrl, icons } = await scanPage(siteUrl, allowPrivate);
    out.push(...icons, new URL("/apple-touch-icon.png", finalUrl).href, new URL("/favicon.ico", finalUrl).href);
  } catch {}
  // Google's service only works for public sites, but it's a decent last resort.
  out.push(`https://www.google.com/s2/favicons?domain=${new URL(siteUrl).hostname}&sz=128`);
  return out;
}

// Choices for the Logo picker, in order: Dashboard Icons variants (plex ->
// plex, plex-alt, plex-light...), Simple Icons marks (youtubemusic -> youtube,
// youtubetv...), then images from the site itself.
const previewable = new Map(); // remote image URL the preview proxy may fetch -> allowPrivate
const previewCache = new Map(); // typed Icon URL -> image | null
async function logoOptions(name, url, allowPrivate) {
  await Promise.all([loadBrands(), loadDashIcons()]);
  const options = [];
  const dash = dashFor({ name, url });
  if (dash) {
    // Family root: "youtube-music" -> also offer "youtube", "youtube-tv"...
    const parts = dash.split("-");
    let rootName = dash;
    for (let i = 1; i <= parts.length; i++) {
      if (dashNames.has(parts.slice(0, i).join("-"))) { rootName = parts.slice(0, i).join("-"); break; }
    }
    const family = [dash, ...dashFamily(rootName).filter((n) => n !== dash)].slice(0, 8);
    for (const n of family) options.push({ kind: "dash", name: n, preview: `/api/dash/${n}` });
  }
  const match = brandFor({ name, url });
  if (match && brands) {
    // Family root = shortest known slug that prefixes the match ("youtube" for "youtubemusic").
    let root = match.slug;
    for (let i = 3; i < match.slug.length; i++) {
      if (brands.has(match.slug.slice(0, i))) { root = match.slug.slice(0, i); break; }
    }
    const family = [...brands.keys()].filter((k) => k.startsWith(root)).sort((a, b) => a.length - b.length || a.localeCompare(b));
    for (const slug of [match.slug, ...family.filter((k) => k !== match.slug)].slice(0, 8)) {
      options.push({ kind: "brand", slug, hex: `#${brands.get(slug)}` });
    }
  }
  try {
    const { icons, logos } = await scanPage(url, allowPrivate);
    const seen = new Set();
    // Only logos hosted on the site's own domain (a dashboard page links plenty of
    // other apps' logos), and the two best icons (sites list one icon at many sizes).
    const domain = (h) => h.split(".").slice(-2).join(".");
    const own = logos.filter((l) => domain(new URL(l).hostname) === domain(new URL(url).hostname));
    for (const src of [...own.slice(0, 3), ...icons.slice(0, 2)]) {
      if (seen.has(src)) continue;
      seen.add(src);
      if (previewable.size > 500) previewable.clear();
      previewable.set(src, allowPrivate);
      options.push({ kind: "image", src, preview: `/api/preview?u=${encodeURIComponent(src)}` });
    }
  } catch {}
  // What "Auto" would pick for this name + address, so the edit box can preview it.
  return { options, auto: artFor({ name, url }) || null };
}

async function getIcon(site, allowPrivate) {
  // Separate cache entries, so a private-network icon never reaches an untrusted tile.
  const key = crypto.createHash("sha1").update(`${allowPrivate ? "" : "public:"}${site.icon || site.url}`).digest("hex");
  if (iconCache.has(key)) return iconCache.get(key);
  const file = path.join(ICON_DIR, key);
  try {
    const meta = JSON.parse(fs.readFileSync(`${file}.json`, "utf8"));
    const hit = { type: meta.type, buf: fs.readFileSync(file) };
    iconCache.set(key, hit);
    return hit;
  } catch {}
  let hit = null;
  for (const url of site.icon ? [site.icon] : await iconCandidates(site.url, allowPrivate)) {
    hit = await fetchImage(url, allowPrivate).catch(() => null);
    if (hit) break;
  }
  iconCache.set(key, hit);
  if (hit) {
    fs.mkdirSync(ICON_DIR, { recursive: true });
    fs.writeFileSync(file, hit.buf);
    fs.writeFileSync(`${file}.json`, JSON.stringify({ type: hit.type }));
  } else {
    setTimeout(() => iconCache.delete(key), 10 * 60_000); // retry misses later
  }
  return hit;
}

// ---------- Brand logos (Simple Icons) ----------
// Official single-color logos + brand colors for well-known services, used for
// the big Theater-style cards. Data is fetched once and cached under /data.
const SI_BASE = "https://cdn.jsdelivr.net/npm/simple-icons@latest";
const LOGO_DIR = path.join(DATA_DIR, "logos");
const BRANDS_FILE = path.join(DATA_DIR, "simple-icons.json");
let brands = null; // slug -> hex

function slugify(s) {
  return s.toLowerCase().replace(/\+/g, "plus").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}

// A remote JSON index kept on disk under /data and refreshed after 30 days.
// The returned loader resolves at once when loaded() is already true, and
// otherwise returns the in-flight download so callers can await it.
function cachedIndex({ file, url, what, loaded, index }) {
  let loading = null;
  return () => {
    if (loaded() || loading) return loading;
    try {
      const stat = fs.statSync(file);
      index(JSON.parse(fs.readFileSync(file, "utf8")));
      if (Date.now() - stat.mtimeMs < 30 * 86_400_000) return null;
    } catch {}
    loading = fetch(url, { signal: AbortSignal.timeout(20_000) })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => {
        index(JSON.parse(text));
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(file, text);
      })
      .catch((err) => console.warn(`Couldn't load ${what}: ${err.message}`))
      .finally(() => (loading = null));
    return loading;
  };
}

// An SVG kept on disk under dir, fetched from remoteUrl the first time.
async function cachedSvg(dir, name, remoteUrl) {
  const file = path.join(dir, `${name}.svg`);
  try {
    return fs.readFileSync(file);
  } catch {}
  const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

const loadBrands = cachedIndex({
  file: BRANDS_FILE,
  url: `${SI_BASE}/data/simple-icons.json`,
  what: "brand list",
  loaded: () => brands,
  index: (list) => {
    brands = new Map();
    for (const i of Array.isArray(list) ? list : list.icons || []) brands.set(i.slug || slugify(i.title), i.hex);
  },
});

// Match by tile name first ("YouTube Music" -> youtubemusic), then hostname parts.
function brandFor(site) {
  if (!brands || site.logo === "none" || site.logo?.startsWith("di:")) return null;
  if (site.logo && brands.has(site.logo)) return { slug: site.logo, hex: `#${brands.get(site.logo)}` };
  for (const slug of siteKeys(site)) if (brands.has(slug)) return { slug, hex: `#${brands.get(slug)}` };
  return null;
}

// ---------- Full-color logos (Dashboard Icons) ----------
// homarr-labs/dashboard-icons: full-color SVG logos for self-hosted + streaming
// apps (the orange Plex chevron, Immich's pinwheel, Disney+, Hulu...). Primary
// logo source; Simple Icons is the fallback.
const DI_BASE = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons";
const DI_FILE = path.join(DATA_DIR, "dashboard-icons.json");
const DI_DIR = path.join(DATA_DIR, "dashboard-icons");
let dashIcons = null; // dashless key -> first name, e.g. "plex" -> "plex"
let dashNames = null; // Set of names

const loadDashIcons = cachedIndex({
  file: DI_FILE,
  url: `${DI_BASE}/tree.json`,
  what: "dashboard icons",
  loaded: () => dashIcons,
  index: (tree) => {
    dashNames = new Set((tree.svg || []).map((f) => f.replace(/\.svg$/, "")));
    dashIcons = new Map();
    for (const n of dashNames) {
      const key = n.replace(/-/g, "");
      if (!dashIcons.has(key)) dashIcons.set(key, n);
    }
  },
});

function siteKeys(site) {
  const host = new URL(site.url).hostname.split(".").slice(0, -1).filter((p) => !["www", "app", "open", "web"].includes(p));
  return [slugify(site.name), slugify([...host].reverse().join("")), ...host.map(slugify)].filter(Boolean);
}

function dashFor(site) {
  if (!dashIcons) return null;
  for (const key of siteKeys(site)) if (dashIcons.has(key)) return dashIcons.get(key);
  return null;
}

// Every variant of an icon: plex -> plex, plex-alt, plex-light, plex-alt-light...
function dashFamily(name) {
  return [...dashNames].filter((n) => n === name || n.startsWith(`${name}-`))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

function iconVersion(str) {
  let v = 0;
  for (const c of str) v = (v * 31 + c.charCodeAt(0)) >>> 0;
  return v.toString(36);
}

// What a card shows, computed on the fly (never stored; validSites drops it):
//   { type: "image", src }       Dashboard Icons logo (primary) or custom image
//   { type: "mark", slug, hex }  single-color Simple Icons logo (fallback), tinted by the client
function artFor(site) {
  if (site.icon) return { type: "image", src: `/api/icon/${site.id}?v=${iconVersion(site.icon)}` };
  if (site.logo === "none") return null;
  if (site.logo?.startsWith("di:")) {
    const name = site.logo.slice(3);
    return dashNames?.has(name) ? { type: "image", src: `/api/dash/${name}` } : null;
  }
  if (!site.logo) {
    const dash = dashFor(site);
    if (dash) return { type: "image", src: `/api/dash/${dash}` };
  }
  const brand = brandFor(site);
  return brand ? { type: "mark", ...brand } : null;
}

async function withBrands(sites) {
  await Promise.all([loadBrands(), loadDashIcons()]);
  return sites.map((s) => ({ ...s, art: artFor(s) || undefined }));
}

function fromTrustedProxy(req) {
  const ip = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return net.isIP(ip) && TRUSTED_PROXIES.check(ip, net.isIP(ip) === 6 ? "ipv6" : "ipv4");
}

// Only a fallback: set FRUNK_PUBLIC_URL so links never depend on request headers.
function requestOrigin(req) {
  const trusted = fromTrustedProxy(req);
  const proto = (trusted && req.headers["x-forwarded-proto"]) || "http";
  return `${proto}://${(trusted && req.headers["x-forwarded-host"]) || req.headers.host}`;
}

// Applied to every response.
const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style", // Google's button injects inline styles
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://accounts.google.com/gsi/",
    "frame-src https://accounts.google.com/gsi/",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};
// For images served from our origin (some fetched from other sites): an SVG
// opened directly must not be able to run scripts here.
function sendImage(res, type, buf, cacheControl) {
  res.writeHead(200, {
    "content-type": type,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  res.end(buf);
}

function json(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 256 * 1024) req.destroy(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// ---------- Email (invites) ----------
const mailer = createMailer({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASSWORD,
  from: process.env.SMTP_FROM || `Frunk <${process.env.SMTP_USER}>`,
});

// Kept in /data so it survives restarts (container logs don't).
function mailLog(line) {
  const entry = `${new Date().toISOString()} ${line}`;
  console.log(entry);
  try {
    fs.appendFileSync(path.join(DATA_DIR, "mail.log"), `${entry}\n`);
  } catch {}
}

const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Invite (or password reset) email. Returns null on success, or the error text.
async function emailInvite(invite, link, inviter) {
  if (!mailer) return "Email isn't set up";
  const isReset = !!accounts.byEmail(invite.email);
  const kind = isReset ? "password reset" : "invite";
  const who = (inviter.name || inviter.email.split("@")[0]).trim();
  const tiles = (invite.tiles || []).map((t) => t.name);
  const subject = isReset ? "Reset your Frunk password" : `${who} invited you to Frunk`;
  const lead = isReset
    ? "Use the button below to choose a new password for Frunk."
    : `${who} invited you to Frunk, a fullscreen launcher for your car's browser with big touch-friendly tiles.`;
  const extra = tiles.length ? `Your page will start with: ${tiles.join(", ")}.` : "";
  const google = isReset ? "" : `You can also just tap “Continue with Google” on Frunk using ${invite.email}.`;
  const text = [lead, "", `${isReset ? "Reset password" : "Join Frunk"}: ${link}`, "", extra, google,
    "", "This link works once and expires in 14 days."].join("\n");
  const button = isReset ? "Choose a new password" : "Join Frunk";
  const html = `<!doctype html><html><body style="margin:0;background:#0f1114;font-family:Inter,Arial,sans-serif;color:#e8eaed">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1114;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#181b20;border-radius:20px;padding:32px">
<tr><td style="font-size:28px;font-weight:700;letter-spacing:.12em;color:#fff">FRUNK</td></tr>
<tr><td style="padding-top:20px;font-size:17px;line-height:1.5;color:#e8eaed">${escapeHtml(lead)}</td></tr>
${extra ? `<tr><td style="padding-top:12px;font-size:15px;line-height:1.5;color:#8e939b">${escapeHtml(extra)}</td></tr>` : ""}
<tr><td style="padding:28px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#3e6ae1;color:#fff;text-decoration:none;font-weight:700;letter-spacing:.06em;padding:16px 28px;border-radius:999px">${button}</a></td></tr>
${google ? `<tr><td style="font-size:14px;line-height:1.5;color:#8e939b">${escapeHtml(google)}</td></tr>` : ""}
<tr><td style="padding-top:16px;font-size:13px;color:#5d626a">This link works once and expires in 14 days. If you weren't expecting this, you can ignore it.</td></tr>
</table></td></tr></table></body></html>`;
  try {
    // Sent as "<inviter> via Frunk". No Reply-To: a free-mail reply address on a
    // custom sending domain scores as forged with spam filters.
    await mailer.send({ to: invite.email, subject, text, html, fromName: `${who} via Frunk` });
    mailLog(`sent ${kind} to ${invite.email}`);
    return null;
  } catch (err) {
    mailLog(`FAILED ${kind} to ${invite.email}: ${err.message}`);
    return err.message;
  }
}

// ---------- Accounts + sessions ----------
const accounts = createAccounts({ dataDir: DATA_DIR, ownerEmail: process.env.FRUNK_OWNER_EMAIL });
accounts.ensureOwner(readSites());
const COOKIE = "frunk_session";

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    // Other apps on the same domain can share this cookie header; their values
    // aren't always valid URI encoding, so never let one break the request.
    const raw = part.slice(i + 1).trim();
    let value = raw;
    try { value = decodeURIComponent(raw); } catch {}
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

function publicOrigin(req) {
  return PUBLIC_URL || requestOrigin(req);
}

function setCookie(res, req, name, value, maxAgeSec) {
  const secure = publicOrigin(req).startsWith("https:") ? "; Secure" : "";
  const prev = res.getHeader("set-cookie") || [];
  res.setHeader("set-cookie", [...[].concat(prev),
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`]);
}

function startSession(res, req, user) {
  setCookie(res, req, COOKIE, accounts.createSession(user.id), SESSION_DAYS * 86400);
}

function currentUser(req) {
  return accounts.userForSession(cookies(req)[COOKIE]);
}

// Per-IP attempt counts over a 15-minute window: password failures (max 10)
// and pairing starts (max 20).
const RATE_WINDOW = 15 * 60_000;
const failures = new Map(); // ip -> { count, since }
function clientIp(req) {
  const forwarded = fromTrustedProxy(req) && (req.headers["x-real-ip"] || req.headers["x-forwarded-for"]);
  return String(forwarded || req.socket.remoteAddress).split(",")[0].trim();
}
setInterval(() => {
  for (const map of [failures, pairStarts]) {
    for (const [ip, f] of map) if (Date.now() - f.since >= RATE_WINDOW) map.delete(ip);
  }
}, RATE_WINDOW).unref();
function overLimit(map, ip, max) {
  const f = map.get(ip);
  return !!f && Date.now() - f.since < RATE_WINDOW && f.count >= max;
}
function noteAttempt(map, ip) {
  const f = map.get(ip);
  if (!f || Date.now() - f.since >= RATE_WINDOW) map.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}

// ---------- Sign in with your phone (QR pairing) ----------
// The car shows a QR code + short code; a signed-in phone approves it; the car's
// next poll gets a session. Pairings live in memory for 10 minutes.
const PAIR_MS = 10 * 60_000;
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const pairs = new Map(); // id -> { code, created, status: "pending"|"approved"|"denied", userId }
const pairStarts = new Map(); // ip -> { count, since }

function newPairCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join("");
  } while ([...pairs.values()].some((p) => p.code === code));
  return code;
}

function findPair(code) {
  code = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const [id, p] of pairs) {
    if (Date.now() - p.created > PAIR_MS) pairs.delete(id);
    else if (p.code === code) return p;
  }
  return null;
}

// ---------- Google sign-in (OpenID Connect, authorization code flow) ----------
function googleRedirectUri(req) {
  return `${publicOrigin(req)}/auth/google/callback`;
}

function redirect(res, location) {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

async function googleCallback(req, res, params) {
  // Only a short code goes in the address; the page has the wording, so a
  // crafted link can't put arbitrary text in the sign-in box.
  const fail = (code, why = code) => {
    console.warn(`Google sign-in failed (${clientIp(req)}): ${why}`);
    return redirect(res, `/?signin_error=${code}`);
  };
  if (params.get("error")) return fail("cancelled", `google returned ${params.get("error")}`);
  // Several attempts can be in flight (tapped twice, page reloaded while
  // approving on the phone), so the cookie keeps the last few states.
  const states = String(cookies(req).frunk_oauth || "").split(".").filter(Boolean);
  const state = params.get("state");
  if (!params.get("code")) return fail("failed", "no code");
  if (!states.length) return fail("expired", "no state cookie (expired or blocked)");
  if (!states.includes(state)) return fail("expired", "state not among recent attempts");
  setCookie(res, req, "frunk_oauth", "", 0);
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: params.get("code"),
      client_id: GOOGLE_ID,
      client_secret: GOOGLE_SECRET,
      redirect_uri: googleRedirectUri(req),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.id_token) return fail("failed", `token exchange ${tokenRes.status} ${tokens.error || ""}`);
  // The ID token came straight from Google's token endpoint over TLS, so its
  // claims can be read directly; still check it was issued for this app.
  const claims = jwtPart(tokens.id_token.split(".")[1]);
  if (claims.aud !== GOOGLE_ID || !GOOGLE_ISSUERS.includes(claims.iss)) {
    return fail("failed", `bad token aud/iss ${claims.aud} ${claims.iss}`);
  }
  const result = accounts.signInWithGoogle(googleUser(claims), readSites());
  if (result.error) return fail(result.code, `${claims.email}: ${result.error}`);
  console.log(`Google sign-in: ${result.user.email}`);
  startSession(res, req, result.user);
  redirect(res, "/");
}

const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const jwtPart = (part) => JSON.parse(Buffer.from(part, "base64url").toString());
const googleUser = (claims) => ({
  sub: claims.sub,
  email: claims.email,
  emailVerified: claims.email_verified === true || claims.email_verified === "true",
  name: claims.name,
});

// ---------- Google One Tap (ID token posted by Google's script) ----------
// Unlike the redirect flow, this token arrives from the browser, so its
// signature is checked against Google's published keys.
let googleKeys = { keys: new Map(), expires: 0, fetching: null };

async function googleKey(kid) {
  if (googleKeys.keys.has(kid) && Date.now() < googleKeys.expires) return googleKeys.keys.get(kid);
  googleKeys.fetching ||= (async () => {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/certs", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Google keys HTTP ${res.status}`);
    const maxAge = Number((/max-age=(\d+)/.exec(res.headers.get("cache-control") || "") || [])[1] || 3600);
    const keys = new Map();
    for (const jwk of (await res.json()).keys || []) keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
    googleKeys = { keys, expires: Date.now() + maxAge * 1000, fetching: null };
  })().finally(() => (googleKeys.fetching = null));
  await googleKeys.fetching;
  return googleKeys.keys.get(kid);
}

async function verifyGoogleIdToken(token, nonce) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = jwtPart(parts[0]);
  const claims = jwtPart(parts[1]);
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);
  const key = await googleKey(header.kid);
  if (!key) throw new Error("unknown signing key");
  const signed = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  if (!signed) throw new Error("bad signature");
  const now = Date.now() / 1000;
  if (claims.aud !== GOOGLE_ID) throw new Error("token is for another app");
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw new Error(`bad issuer ${claims.iss}`);
  if (!(claims.exp > now - 60) || claims.iat > now + 60) throw new Error("token expired");
  if (!nonce || claims.nonce !== nonce) throw new Error("nonce mismatch");
  return claims;
}

// A tile id from any list (default page or any user's), for icon lookups.
// trusted: the tile is on the admin-managed default page or an admin's own page,
// so its icon may be fetched from the server's private network.
function findSite(id, user) {
  const own = (user?.sites || []).find((s) => s.id === id);
  if (own) return { site: own, trusted: !!user.admin };
  const onDefault = readSites().find((s) => s.id === id);
  if (onDefault) return { site: onDefault, trusted: true };
  for (const u of accounts.allUsers()) {
    const site = u.sites.find((s) => s.id === id);
    if (site) return { site, trusted: !!u.admin };
  }
  return null;
}

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 404, { error: "not found" });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: "not found" });
    const ext = path.extname(file);
    if (ext === ".html") buf = Buffer.from(buf.toString().replaceAll("__V__", ASSET_VERSION));
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300",
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  let url, pathname, user;
  const route = (method, p) => req.method === method && pathname === p;
  try {
    url = new URL(req.url, "http://x");
    ({ pathname } = url);
    user = currentUser(req);
    // ---------- Sign-in ----------
    if (route("GET", "/api/me")) {
      return json(res, 200, {
        user: user && { name: user.name, email: user.email, admin: !!user.admin, avatarColor: user.avatarColor || null, pickColor: !!user.pickColor },
        google: !!(GOOGLE_ID && GOOGLE_SECRET),
        googleClientId: GOOGLE_ID || undefined,
      });
    }
    if (route("GET", "/auth/google")) {
      if (!GOOGLE_ID) return redirect(res, "/?signin_error=not_setup");
      const state = crypto.randomBytes(16).toString("base64url");
      // 30 min: phone 2-step prompts can take a while (resend, unlock, app opens first).
      const recent = String(cookies(req).frunk_oauth || "").split(".").filter(Boolean).slice(-4);
      setCookie(res, req, "frunk_oauth", [...recent, state].join("."), 30 * 60);
      return redirect(res, "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
        client_id: GOOGLE_ID,
        redirect_uri: googleRedirectUri(req),
        response_type: "code",
        scope: "openid email profile",
        state,
        prompt: "select_account",
      }));
    }
    if (route("GET", "/auth/google/callback")) return await googleCallback(req, res, url.searchParams);

    // Mutating API calls must be JSON: blocks cross-site form posts (CSRF).
    if (pathname.startsWith("/api/") && req.method !== "GET" &&
        !String(req.headers["content-type"] || "").startsWith("application/json")) {
      return json(res, 415, { error: "expected JSON" });
    }

    if (route("POST", "/api/google/nonce")) {
      // One Tap: a fresh nonce, also kept in a cookie, so a captured token can't be replayed.
      if (!GOOGLE_ID) return json(res, 404, { error: "Google sign-in isn't set up." });
      const nonce = crypto.randomBytes(16).toString("base64url");
      setCookie(res, req, "frunk_gnonce", nonce, 10 * 60);
      return json(res, 200, { nonce });
    }
    if (route("POST", "/api/google/onetap")) {
      const { credential } = (await readBody(req)) || {};
      const nonce = cookies(req).frunk_gnonce;
      setCookie(res, req, "frunk_gnonce", "", 0);
      let claims;
      try {
        claims = await verifyGoogleIdToken(credential, nonce);
      } catch (err) {
        console.warn(`Google One Tap failed (${clientIp(req)}): ${err.message}`);
        return json(res, 401, { error: "Google sign-in failed, try again." });
      }
      const result = accounts.signInWithGoogle(googleUser(claims), readSites());
      if (result.error) return json(res, 403, { error: result.error });
      console.log(`Google One Tap sign-in: ${result.user.email}`);
      startSession(res, req, result.user);
      return json(res, 200, { ok: true });
    }
    if (route("POST", "/api/login")) {
      const ip = clientIp(req);
      if (overLimit(failures, ip, 10)) return json(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
      const { email, password } = (await readBody(req)) || {};
      const found = await accounts.signInWithPassword(email, password);
      if (!found) {
        noteAttempt(failures, ip);
        return json(res, 401, { error: "Wrong email or password." });
      }
      startSession(res, req, found);
      return json(res, 200, { ok: true });
    }
    if (route("POST", "/api/logout")) {
      accounts.endSession(cookies(req)[COOKIE]);
      setCookie(res, req, COOKIE, "", 0);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && pathname.startsWith("/api/invite/")) {
      const invite = accounts.findInvite(pathname.slice("/api/invite/".length));
      if (!invite) return json(res, 404, { error: "This invite link has expired or was already used." });
      return json(res, 200, { email: invite.email, existing: !!accounts.byEmail(invite.email) });
    }
    if (route("POST", "/api/signup")) {
      const { token, name, password, avatarColor } = (await readBody(req)) || {};
      const result = await accounts.acceptInvite(String(token || ""), { name, password: String(password || ""), avatarColor }, readSites());
      if (result.error) return json(res, 400, { error: result.error });
      startSession(res, req, result.user);
      return json(res, 200, { ok: true });
    }

    // ---------- Tiles ----------
    if (route("GET", "/api/sites")) {
      return json(res, 200, await withBrands(user ? user.sites : readSites()));
    }
    if (route("GET", "/api/default")) {
      return json(res, 200, await withBrands(readSites()));
    }
    if (route("GET", "/api/preview")) {
      // Thumbnails for the Logo picker; only URLs logoOptions just offered.
      const u = url.searchParams.get("u");
      const img = previewable.has(u) && (await fetchImage(u, previewable.get(u)).catch(() => null));
      if (!img) return json(res, 404, { error: "no image" });
      return sendImage(res, img.type, img.buf, "private, max-age=3600");
    }
    if (req.method === "GET" && pathname.startsWith("/api/dash/")) {
      const name = pathname.slice("/api/dash/".length);
      const svg = dashNames?.has(name) && (await cachedSvg(DI_DIR, name, `${DI_BASE}/svg/${name}.svg`).catch(() => null));
      if (!svg) return json(res, 404, { error: "no logo" });
      return sendImage(res, "image/svg+xml", svg, "public, max-age=604800");
    }
    if (req.method === "GET" && pathname.startsWith("/api/logo/")) {
      const slug = pathname.slice("/api/logo/".length);
      const svg = brands && brands.has(slug) && (await cachedSvg(LOGO_DIR, slug, `${SI_BASE}/icons/${slug}.svg`).catch(() => null));
      if (!svg) return json(res, 404, { error: "no logo" });
      return sendImage(res, "image/svg+xml", svg, "public, max-age=604800");
    }
    if (req.method === "GET" && pathname.startsWith("/api/icon/")) {
      // Only icons for saved tiles, so this can't be used to fetch arbitrary URLs.
      const found = findSite(pathname.slice("/api/icon/".length), user);
      const icon = found && (await getIcon(found.site, found.trusted));
      if (!icon) return json(res, 404, { error: "no icon" });
      return sendImage(res, icon.type, icon.buf, "public, max-age=86400");
    }
    // ---------- Sign in with your phone: car side (signed out) ----------
    if (route("POST", "/api/pair/start")) {
      const ip = clientIp(req);
      if (overLimit(pairStarts, ip, 20)) return json(res, 429, { error: "Too many attempts. Try again later." });
      noteAttempt(pairStarts, ip);
      const id = crypto.randomBytes(24).toString("base64url");
      const code = newPairCode();
      pairs.set(id, { code, created: Date.now(), status: "pending", userId: null });
      return json(res, 200, { id, code, link: `${publicOrigin(req)}/?pair=${code}`, expiresIn: PAIR_MS / 1000 });
    }
    if (req.method === "GET" && pathname.startsWith("/api/pair/poll/")) {
      const id = pathname.slice("/api/pair/poll/".length);
      const p = pairs.get(id);
      if (!p || Date.now() - p.created > PAIR_MS) {
        pairs.delete(id);
        return json(res, 200, { status: "expired" });
      }
      if (p.status === "approved") {
        pairs.delete(id);
        const approver = accounts.allUsers().find((u) => u.id === p.userId);
        if (!approver) return json(res, 200, { status: "expired" });
        startSession(res, req, approver);
        console.log(`Phone sign-in: ${approver.email}`);
        return json(res, 200, { status: "approved" });
      }
      if (p.status === "denied") pairs.delete(id);
      return json(res, 200, { status: p.status });
    }

    // Everything below needs a signed-in user.
    if (pathname.startsWith("/api/") && !user) return json(res, 401, { error: "Sign in first." });

    if (route("PUT", "/api/me")) {
      const body = (await readBody(req)) || {};
      if ("name" in body && !accounts.setName(user, body.name)) return json(res, 400, { error: "Enter a name." });
      if ("avatarColor" in body && !accounts.setAvatarColor(user, body.avatarColor)) return json(res, 400, { error: "Pick a color like #3e6ae1." });
      return json(res, 200, { name: user.name, email: user.email, admin: !!user.admin, avatarColor: user.avatarColor || null });
    }
    if (route("PUT", "/api/sites") || route("PUT", "/api/default")) {
      const isDefault = pathname === "/api/default";
      if (isDefault && !user.admin) return json(res, 403, { error: "Only the admin can edit the default page." });
      const sites = validSites(await readBody(req));
      if (!sites) return json(res, 400, { error: "invalid site list" });
      if (isDefault) writeSites(sites);
      else accounts.setSites(user, sites);
      return json(res, 200, await withBrands(sites));
    }
    if (route("GET", "/api/preview-url")) {
      // Live preview of an Icon URL typed in the edit box (signed-in users only):
      // proxied so the page can sample its colors for the Auto card color.
      const u = url.searchParams.get("u") || "";
      if (!/^https?:\/\//i.test(u)) return json(res, 400, { error: "invalid url" });
      const key = `${user.admin ? "admin" : "user"} ${u}`; // admins may see private addresses
      let img = previewCache.get(key);
      if (img === undefined) {
        img = await fetchImage(u, !!user.admin).catch(() => null);
        if (previewCache.size > 100) previewCache.clear();
        previewCache.set(key, img);
      }
      if (!img) return json(res, 404, { error: "no image" });
      return sendImage(res, img.type, img.buf, "private, max-age=3600");
    }
    if (route("POST", "/api/logo-options")) {
      const body = (await readBody(req)) || {};
      try {
        return json(res, 200, await logoOptions(String(body.name || ""), new URL(body.url).href, !!user.admin));
      } catch {
        return json(res, 400, { error: "invalid url" });
      }
    }
    // ---------- Sign in with your phone: phone side (signed in) ----------
    if (route("POST", "/api/pair/approve") || route("POST", "/api/pair/deny")) {
      const p = findPair(((await readBody(req)) || {}).code);
      if (!p || p.status !== "pending") return json(res, 404, { error: "That code has expired. Start again on the car." });
      p.status = pathname.endsWith("approve") ? "approved" : "denied";
      p.userId = user.id;
      return json(res, 200, { ok: true });
    }

    // ---------- Admin: people + invites ----------
    if (pathname.startsWith("/api/admin/")) {
      if (!user.admin) return json(res, 403, { error: "Admins only." });
      const inviteLink = (i) => ({ ...i, link: `${publicOrigin(req)}/?invite=${i.token}` });
      // Email a new or renewed invite; the reply says whether that worked.
      const sendInvite = async (invite) => {
        const withLink = inviteLink(invite);
        const emailError = await emailInvite(invite, withLink.link, user);
        return json(res, 200, { ...withLink, emailed: !emailError, emailError: emailError || undefined });
      };
      if (route("GET", "/api/admin/people")) {
        const p = accounts.people();
        return json(res, 200, { ...p, invites: p.invites.map(inviteLink), email: !!mailer });
      }
      if (route("POST", "/api/admin/invites")) {
        const { email, tiles } = (await readBody(req)) || {};
        // Tile ids from the admin's own page; copies go into the invite.
        const picked = Array.isArray(tiles) ? user.sites.filter((t) => tiles.includes(t.id)) : [];
        const invite = accounts.createInvite(email, picked);
        if (!invite) return json(res, 400, { error: "That doesn't look like an email address." });
        return sendInvite(invite);
      }
      if (req.method === "POST" && pathname.startsWith("/api/admin/invites/") && pathname.endsWith("/renew")) {
        // Expired invite -> fresh 14-day link (same email + tiles), emailed again.
        const invite = accounts.renewInvite(pathname.slice("/api/admin/invites/".length, -"/renew".length));
        if (!invite) return json(res, 404, { error: "That invite no longer exists." });
        return sendInvite(invite);
      }
      if (req.method === "POST" && pathname.startsWith("/api/admin/invites/") && pathname.endsWith("/resend")) {
        const token = pathname.slice("/api/admin/invites/".length, -"/resend".length);
        const invite = accounts.findInvite(token);
        if (!invite) return json(res, 404, { error: "That invite has expired." });
        const emailError = await emailInvite(invite, inviteLink(invite).link, user);
        return emailError ? json(res, 502, { error: `Couldn't send: ${emailError}` }) : json(res, 200, { ok: true });
      }
      if (req.method === "DELETE" && pathname.startsWith("/api/admin/invites/")) {
        accounts.deleteInvite(pathname.slice("/api/admin/invites/".length));
        return json(res, 200, { ok: true });
      }
      if (req.method === "DELETE" && pathname.startsWith("/api/admin/users/")) {
        if (!accounts.deleteUser(pathname.slice("/api/admin/users/".length))) {
          return json(res, 400, { error: "Can't remove that account." });
        }
        return json(res, 200, { ok: true });
      }
    }

    if (pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    let file;
    try { file = decodeURIComponent(pathname); } catch { return json(res, 404, { error: "not found" }); }
    if (file === "/pair") file = "/"; // short address for typing a car's code on a phone
    serveStatic(req, res, file);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: "server error" });
  }
});

loadBrands();
loadDashIcons();
server.listen(PORT, () => {
  console.log(`Frunk listening on :${PORT}`);
  if (!process.env.FRUNK_OWNER_EMAIL) console.warn("FRUNK_OWNER_EMAIL isn't set — nobody is admin and nobody can be invited.");
  if (!GOOGLE_ID || !GOOGLE_SECRET) console.warn("GOOGLE_CLIENT_ID/SECRET aren't set — Google sign-in is off.");
  if (!mailer) console.warn("SMTP_* isn't set — invites won't be emailed (links are copied instead).");
  // First run (or Google not set up yet): give the owner a way in.
  const owner = process.env.FRUNK_OWNER_EMAIL && accounts.byEmail(process.env.FRUNK_OWNER_EMAIL);
  if (owner && !owner.password && !(owner.google && GOOGLE_ID)) {
    const invite = accounts.pendingInvite(owner.email) || accounts.createInvite(owner.email);
    console.log(`Set the admin password here: ${PUBLIC_URL || `http://localhost:${PORT}`}/?invite=${invite.token}`);
  }
});
