// Test helpers: a fake logo CDN + website, and a real Frunk server started as a
// child process (PORT=0, its own temp DATA_DIR), so tests go through HTTP
// exactly like a browser does and never touch the internet.
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const OWNER = "owner@example.com";

// Every logo the app's Popular picks ask for, so the fake CDN has them all.
const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const POPULAR_DASH = [...appJs.matchAll(/\bdash: "([a-z0-9-]+)"/g)].map((m) => m[1]);
const POPULAR_SI = [...appJs.matchAll(/\bsi: "([a-z0-9]+)"/g)].map((m) => m[1]);

const svg = (label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>${label}</title><rect width="24" height="24"/></svg>`;
// Big enough for the server to accept as an image (it ignores anything under 100 bytes).
const png = (size = 200) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(size - 8, 1)]);

// Serves both logo indexes, their SVGs, and a small website with an icon.
// hits counts requests per path; set down = true to answer everything with 500.
async function fakeCdn() {
  const hits = {};
  const cdn = { hits, down: false };
  const server = http.createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url, "http://x");
    hits[pathname] = (hits[pathname] || 0) + 1;
    const send = (type, body) => res.writeHead(200, { "content-type": type }).end(body);
    if (cdn.down) return res.writeHead(500).end();
    if (pathname === "/si/data/simple-icons.json") {
      return send("application/json", JSON.stringify([
        { title: "YouTube", hex: "FF0000" },
        ...POPULAR_SI.map((slug) => ({ slug, title: slug, hex: "222222" })),
      ]));
    }
    if (pathname === "/di/tree.json") {
      const names = ["netflix", "plex", "plex-alt", ...POPULAR_DASH];
      return send("application/json", JSON.stringify({ svg: [...new Set(names)].map((n) => `${n}.svg`) }));
    }
    if (/^\/(si\/icons|di\/svg)\/[a-z0-9-]+\.svg$/.test(pathname)) return send("image/svg+xml", svg(pathname));
    if (pathname === "/site/") return send("text/html", '<html><head><link rel="icon" href="/site/icon.png"></head></html>');
    if (pathname === "/site/icon.png") return send("image/png", png());
    if (pathname === "/big.png") return send("image/png", png(Number(searchParams.get("kb")) * 1024));
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref(); // a test that fails before its cleanup must not hang the run
  cdn.base = `http://127.0.0.1:${server.address().port}`;
  cdn.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return cdn;
}

// A small Audiobookshelf: one book library with one book, its HLS stream,
// and a cover. Only Bearer KEY gets in. closed lists sessions that ended.
const ABS_KEY = "abs-test-key";
async function fakeAbs() {
  const abs = { hits: {}, closed: [] };
  const book = { id: "li_1", media: { metadata: { title: "Project Hail Mary", authorName: "Andy Weir" } } };
  const server = http.createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url, "http://x");
    abs.hits[pathname] = (abs.hits[pathname] || 0) + 1;
    const send = (type, body) => res.writeHead(200, { "content-type": type }).end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${ABS_KEY}`) return res.writeHead(401).end("Unauthorized");
    if (pathname === "/api/me") return send("application/json", { id: "u1", username: "jordan" });
    if (pathname === "/api/libraries") return send("application/json", { libraries: [{ id: "lib1", name: "Books", mediaType: "book" }, { id: "pod", name: "Podcasts", mediaType: "podcast" }] });
    if (pathname === "/api/libraries/lib1/items") return send("application/json", { results: [book], total: 1 });
    if (pathname === "/api/libraries/lib1/search") {
      const hit = /hail/i.test(searchParams.get("q"));
      return send("application/json", { book: hit ? [{ libraryItem: { id: "li_1", media: { metadata: { title: "Project Hail Mary", authors: [{ name: "Andy Weir" }] } } } }] : [] });
    }
    if (pathname === "/api/items/li_1/play" && req.method === "POST") {
      const id = `sess${(abs.hits[pathname])}`;
      return send("application/json", { id, displayTitle: "Project Hail Mary", displayAuthor: "Andy Weir", audioTracks: [{ contentUrl: `/hls/${id}/output.m3u8` }] });
    }
    let m;
    if ((m = /^\/hls\/(sess\d+)\/output\.m3u8$/.exec(pathname))) return send("application/vnd.apple.mpegurl", `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n/hls/${m[1]}/output-0.ts\n#EXT-X-ENDLIST\n`);
    if (/^\/hls\/sess\d+\/output-0\.ts$/.test(pathname)) return send("video/mp2t", Buffer.from("segment-bytes"));
    if (pathname === "/api/items/li_1/cover") return send("image/png", png());
    if ((m = /^\/api\/session\/(sess\d+)\/close$/.exec(pathname))) {
      abs.closed.push(m[1]);
      return send("application/json", {});
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  abs.base = `http://127.0.0.1:${server.address().port}`;
  abs.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return abs;
}

// A small Plex server plus plex.tv (under /tv): code linking, a movie, a show
// with a season and an episode, search, and the HLS transcoder's nested
// playlists. Set linked once "the code was entered"; shared: false makes the
// account one this server isn't shared with. Only X-Plex-Token: server-token
// gets into the library. started/stopped list transcode sessions.
async function fakePlex() {
  const plex = { linked: false, shared: true, started: [], stopped: [], segmentTokens: [] };
  const movie = { ratingKey: "100", type: "movie", title: "Arrival", year: 2016, thumb: "/t/100" };
  const show = { ratingKey: "200", type: "show", title: "Bluey", childCount: 3, thumb: "/t/200" };
  const season = { ratingKey: "201", type: "season", title: "Season 1", parentTitle: "Bluey" };
  const episode = { ratingKey: "202", type: "episode", title: "Magic Xylophone", grandparentTitle: "Bluey", parentIndex: 1, index: 1, thumb: "/t/202" };
  const server = http.createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url, "http://x");
    const json = (body) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    const list = (Metadata) => json({ MediaContainer: { Metadata } });
    if (pathname === "/tv/api/v2/pins" && req.method === "POST") return json({ id: 42, code: "ABCD" });
    if (pathname === "/tv/api/v2/pins/42") return json({ id: 42, authToken: plex.linked ? "account-token" : null });
    if (pathname === "/tv/api/v2/resources") return json(plex.shared ? [{ clientIdentifier: "machine1", accessToken: "server-token", provides: "server" }] : []);
    if (pathname === "/tv/api/v2/user") return json({ username: "jordan" });
    if (pathname === "/identity") return json({ MediaContainer: { machineIdentifier: "machine1" } });
    if (req.headers["x-plex-token"] !== "server-token") return res.writeHead(401).end();
    if (pathname === "/library/sections") return json({ MediaContainer: { Directory: [{ key: "1", type: "movie", title: "Movies" }, { key: "2", type: "show", title: "TV Shows" }, { key: "3", type: "photo", title: "Photos" }] } });
    if (pathname === "/library/sections/1/all") return list([movie]);
    if (pathname === "/library/sections/2/all") return list([show]);
    if (pathname === "/library/metadata/200/children") return list([season]);
    if (pathname === "/library/metadata/201/children") return list([episode]);
    if (pathname === "/library/onDeck") return list([episode]);
    const one = { "/library/metadata/100": movie, "/library/metadata/200": show, "/library/metadata/202": episode }[pathname];
    if (one) return list([one]);
    if (pathname === "/hubs/search") return json({ MediaContainer: { Hub: [{ Metadata: /blu/i.test(searchParams.get("query")) ? [show, { ratingKey: "9", type: "photo", title: "Bluey photo" }] : [] }] } });
    const base = "/video/:/transcode/universal";
    if (pathname === `${base}/start.m3u8`) {
      plex.started.push(searchParams.get("session"));
      return res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }).end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\nsession/${searchParams.get("session")}/base/index.m3u8\n`);
    }
    let m;
    if ((m = /^\/video\/:\/transcode\/universal\/session\/([\w-]+)\/base\/index\.m3u8$/.exec(pathname))) {
      return res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }).end("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n00000.ts\n#EXT-X-ENDLIST\n");
    }
    if (/\/base\/00000\.ts$/.test(pathname)) {
      plex.segmentTokens.push(req.headers["x-plex-token"]);
      return res.writeHead(200, { "content-type": "video/mp2t" }).end("plex-seg");
    }
    if (pathname === `${base}/stop`) {
      plex.stopped.push(searchParams.get("session"));
      return res.writeHead(200).end();
    }
    if (pathname === "/photo/:/transcode") return res.writeHead(200, { "content-type": "image/png" }).end(png());
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  plex.base = `http://127.0.0.1:${server.address().port}`;
  plex.env = { PLEX_URL: plex.base, PLEX_TV_URL: `${plex.base}/tv` };
  plex.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return plex;
}

// Starts server.js. seedIndexes writes fresh copies of both logo indexes into
// DATA_DIR so startup doesn't download them (pass false to test the download).
async function startServer({ cdn, env = {}, seedIndexes = true, owner = OWNER } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "frunk-test-"));
  if (seedIndexes && cdn) {
    for (const [file, url] of [["simple-icons.json", "/si/data/simple-icons.json"], ["dashboard-icons.json", "/di/tree.json"]]) {
      fs.writeFileSync(path.join(dataDir, file), await (await fetch(cdn.base + url)).text());
    }
    for (const k of Object.keys(cdn.hits)) delete cdn.hits[k];
  }
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      PATH: process.env.PATH,
      PORT: "0",
      DATA_DIR: dataDir,
      ...(owner ? { FRUNK_OWNER_EMAIL: owner } : {}),
      SIMPLE_ICONS_URL: cdn ? `${cdn.base}/si` : "http://127.0.0.1:9/si",
      DASHBOARD_ICONS_URL: cdn ? `${cdn.base}/di` : "http://127.0.0.1:9/di",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Never outlive the test run, even when a test fails before stopping it.
  const killOnExit = () => child.kill();
  process.once("exit", killOnExit);
  child.once("exit", () => process.off("exit", killOnExit));
  let log = "";
  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      log += chunk;
      const port = /listening on :(\d+)/.exec(log)?.[1];
      // Wait for the admin's setup link too, when the server is going to print one.
      if (port && (/invite=[\w-]+/.test(log) || /no sign-up link|nobody is admin/.test(log) || !owner)) resolve(Number(port));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`server exited (${code}):\n${log}`)));
    setTimeout(() => reject(new Error(`server didn't start:\n${log}`)), 10_000).unref();
  });
  const port = await ready;
  const srv = {
    base: `http://127.0.0.1:${port}`,
    port,
    dataDir,
    get log() { return log; },
    get ownerToken() { return /invite=([\w-]+)/.exec(log)?.[1]; },
    alive: () => child.exitCode === null,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      child.kill();
    }),
  };
  srv.request = (method, urlPath, opts = {}) => request(srv.base, method, urlPath, opts);
  return srv;
}

// One HTTP call. body (an object) is sent as JSON unless raw is given. Like the
// app, every non-GET call says it's JSON (the server refuses anything else).
// Returns { status, headers, body (parsed JSON when possible), cookie }.
async function request(base, method, urlPath, { body, raw, cookie, headers = {} } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    redirect: "manual",
    headers: {
      ...(method !== "GET" ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  const session = res.headers.getSetCookie().find((c) => c.startsWith("frunk_session="));
  return { status: res.status, headers: res.headers, body: parsed, cookie: session && session.split(";")[0] };
}

// Signs up through an invite token; returns the new session cookie.
async function signUp(srv, token, { name = "Someone", password = "a-long-password" } = {}) {
  const r = await srv.request("POST", "/api/signup", { body: { token, name, password } });
  if (r.status !== 200) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.cookie;
}

// A server with an admin (owner) and a regular member, both signed in.
async function serverWithPeople(opts) {
  const srv = await startServer(opts);
  const admin = await signUp(srv, srv.ownerToken, { name: "Owner" });
  const invite = await srv.request("POST", "/api/admin/invites", { cookie: admin, body: { email: "member@example.com" } });
  const member = await signUp(srv, invite.body.token, { name: "Member" });
  return { srv, admin, member };
}

module.exports = { OWNER, ABS_KEY, fakeAbs, fakePlex, fakeCdn, startServer, request, signUp, serverWithPeople, png };
