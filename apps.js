// Apps a Watch Party can play from: servers the admin names in the
// environment (ABS_URL, PLEX_URL). Each person connects their own account;
// requests only ever go to the configured server, so nobody can point Frunk
// at another machine. Keys and tokens stay on the server.
const crypto = require("node:crypto");

// A stream from an app, played through Frunk. Members ask for short aliases
// ("0.m3u8", "17.ts"), never the app's own addresses, and Frunk adds the
// host's credentials. Playlists are rewritten so every entry is an alias too.
// The entry playlist is fetched from the app once and reused: for Plex, asking
// again restarts the conversion, so each new member would set everyone back.
const PIECE_WAIT_MS = 10_000;
function createStream({ entry, headers, stop = () => {} }) {
  const urls = [];
  const ids = new Map();
  function alias(url) {
    let n = ids.get(url);
    if (n === undefined) {
      n = urls.push(url) - 1;
      ids.set(url, n);
    }
    const ext = /\.(m3u8|ts|m4s|mp4|aac|mp3|vtt)$/.exec(new URL(url).pathname);
    return `${n}.${ext ? ext[1] : "bin"}`;
  }
  const urlOf = (name) => {
    const url = urls[Number(/^(\d+)\./.exec(name)?.[1])];
    return url && alias(url) === name ? url : null;
  };
  const entryName = alias(entry);
  let entryCopy = null; // { text, type, url } once the app answered
  return {
    entry: entryName,
    stop,
    // The upstream response for an alias, or null for one this stream never gave out.
    async fetch(name, range) {
      const url = urlOf(name);
      if (!url) return null;
      if (name === entryName && entryCopy) return copyResponse(entryCopy);
      const get = () => fetch(url, { headers: { ...headers, ...(range ? { range } : {}) }, signal: AbortSignal.timeout(60_000) });
      let r = await get();
      // Apps convert as they go: right after a start or a long skip, a piece
      // is "not found" for a few seconds. Wait for it here, so every player
      // (each with its own retry rules) just sees it arrive a little late.
      const waitUntil = Date.now() + PIECE_WAIT_MS;
      while (r.status === 404 && !/\.m3u8$/.test(name) && Date.now() < waitUntil) {
        await r.arrayBuffer().catch(() => {});
        await new Promise((res) => setTimeout(res, 700));
        r = await get();
      }
      if (name !== entryName || !r.ok) return r;
      entryCopy = { text: await r.text(), type: r.headers.get("content-type"), url: r.url };
      return copyResponse(entryCopy);
    },
    rewrite(text, base) {
      return text.split("\n").map((line) => {
        const l = line.trim();
        if (!l) return line;
        if (l.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${alias(new URL(u, base).href)}"`);
        return alias(new URL(l, base).href);
      }).join("\n");
    },
  };
}

// A Response for a kept playlist; url is where it came from, for its relative entries.
function copyResponse({ text, type, url }) {
  const r = new Response(text, { headers: { "content-type": type || "application/vnd.apple.mpegurl" } });
  Object.defineProperty(r, "url", { value: url });
  return r;
}

// Audiobookshelf, connected with an API key. Books play through its HLS
// transcoder, so a book of many files is one stream.
function createAbs(baseUrl) {
  const base = baseUrl.replace(/\/$/, "");
  async function call(token, path, { method = "GET", body } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error("Audiobookshelf didn't accept that key."), { status: 401 });
    if (!res.ok) throw new Error(`Audiobookshelf answered ${res.status}.`);
    return res.json();
  }
  const author = (m) => m.authorName || (m.authors || []).map((a) => a.name).join(", ");
  const toItem = (li) => ({ id: li.id, title: li.media.metadata.title || "Untitled", subtitle: author(li.media.metadata), kind: "audio", art: true });
  async function bookLibraries(token) {
    const { libraries } = await call(token, "/api/libraries");
    return libraries.filter((l) => l.mediaType === "book");
  }

  return {
    id: "abs",
    name: "Audiobookshelf",
    connect: "key",
    help: "In Audiobookshelf, open Settings → API Keys, add a key, and paste it here.",
    hosts: [new URL(base).hostname],
    // { token, account } for a key that works; throws otherwise.
    async connectKey(token) {
      const me = await call(token, "/api/me");
      return { token, account: me.username || "your account" };
    },
    // Recently added, or what matches q, across the book libraries.
    async browse(token, q) {
      const items = [];
      for (const lib of await bookLibraries(token)) {
        if (q) {
          const found = await call(token, `/api/libraries/${lib.id}/search?${new URLSearchParams({ q, limit: "12" })}`);
          items.push(...(found.book || []).map((b) => toItem(b.libraryItem)));
        } else {
          const { results } = await call(token, `/api/libraries/${lib.id}/items?${new URLSearchParams({ sort: "addedAt", desc: "1", limit: "24", minified: "1" })}`);
          items.push(...results.map(toItem));
        }
      }
      return items.slice(0, 48);
    },
    // A playback session on the host's account, ended by stream.stop().
    async start(token, itemId) {
      const s = await call(token, `/api/items/${encodeURIComponent(itemId)}/play`, {
        method: "POST",
        body: { deviceInfo: { clientName: "Frunk Watch Party" }, forceTranscode: true, forceDirectPlay: false, mediaPlayer: "html5", supportedMimeTypes: [] },
      });
      const track = (s.audioTracks || [])[0];
      if (!track || !/^\/hls\//.test(track.contentUrl)) throw new Error("Audiobookshelf didn't start a stream.");
      return {
        title: s.displayTitle || "Untitled",
        subtitle: s.displayAuthor || "",
        kind: "audio",
        art: true,
        stream: createStream({
          entry: base + track.contentUrl,
          headers: { authorization: `Bearer ${token}` },
          stop: () => call(token, `/api/session/${encodeURIComponent(s.id)}/close`, { method: "POST", body: {} }).catch(() => {}),
        }),
      };
    },
    art: (token, itemId) => fetch(`${base}/api/items/${encodeURIComponent(itemId)}/cover?width=400`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }),
  };
}

// Plex, connected by entering a code at plex.tv/link. What's stored is the
// token for this one server (not the whole Plex account), so it works for
// people the server is shared with too. Everyone in a party watches one
// transcode session: Plex works once, Frunk hands the pieces out.
function createPlex(baseUrl, plexTv = "https://plex.tv", extraHosts = []) {
  const base = baseUrl.replace(/\/$/, "");
  // Plex knows each app by an id; this one is fixed per Frunk server.
  const client = `frunk-${crypto.createHash("sha256").update(base).digest("hex").slice(0, 16)}`;
  const plexHeaders = (token) => ({
    accept: "application/json",
    "x-plex-client-identifier": client,
    "x-plex-product": "Frunk",
    "x-plex-platform": "Chrome",
    "x-plex-device-name": "Frunk Watch Party",
    ...(token ? { "x-plex-token": token } : {}),
  });
  async function call(url, token, { method = "GET" } = {}) {
    const res = await fetch(url, { method, headers: plexHeaders(token), signal: AbortSignal.timeout(15_000) });
    if (res.status === 401) throw Object.assign(new Error("Plex didn't accept this account. Connect it again."), { status: 401 });
    if (!res.ok) throw new Error(`Plex answered ${res.status}.`);
    return res.json();
  }
  const library = async (token, path) => (await call(base + path, token)).MediaContainer || {};

  // Folders (shows, seasons, artists, albums) open; the rest play.
  const FOLDERS = ["show", "season", "artist", "album"];
  function toItem(m) {
    const kind = FOLDERS.includes(m.type) ? "folder" : m.type === "track" ? "audio" : "video";
    const ep = m.type === "episode" && m.parentIndex != null ? ` · S${m.parentIndex}E${m.index}` : "";
    const subtitle = {
      movie: m.year ? String(m.year) : "",
      show: m.childCount ? `${m.childCount} season${m.childCount === 1 ? "" : "s"}` : m.year ? String(m.year) : "",
      season: m.parentTitle || "",
      episode: `${m.grandparentTitle || ""}${ep}`,
      artist: "Artist",
      album: m.parentTitle || "",
      track: m.grandparentTitle || m.originalTitle || "",
    }[m.type] || "";
    return { id: String(m.ratingKey), title: m.title || "Untitled", subtitle, kind, art: !!(m.thumb || m.parentThumb || m.grandparentThumb) };
  }
  const PLAYABLE = ["movie", "show", "season", "episode", "artist", "album", "track"];

  return {
    id: "plex",
    name: "Plex",
    connect: "link",
    linkAt: "plex.tv/link", // where the code is entered
    // Your Plex tile, the Plex web app, and PlexDrive (the car player for Plex), if set up.
    hosts: [new URL(base).hostname, "app.plex.tv", ...extraHosts],
    link: {
      async start() {
        const pin = await call(`${plexTv}/api/v2/pins`, null, { method: "POST" });
        return { id: pin.id, code: pin.code };
      },
      // { token, account } once the code was entered, null while waiting.
      async check(pinId) {
        const pin = await call(`${plexTv}/api/v2/pins/${encodeURIComponent(pinId)}`, null);
        if (!pin.authToken) return null;
        const machine = (await library(null, "/identity")).machineIdentifier;
        const resources = await call(`${plexTv}/api/v2/resources?includeHttps=1`, pin.authToken);
        const server = resources.find((r) => r.clientIdentifier === machine);
        if (!server || !server.accessToken) throw new Error("That Plex account can't see this server. Ask the owner to share it with you.");
        const user = await call(`${plexTv}/api/v2/user`, pin.authToken);
        return { token: server.accessToken, account: user.username || user.title || "your account" };
      },
    },
    // Top level: continue watching and each movie, TV and music library.
    // in: a folder to open ("deck", "s<section>", or an item id).
    async browse(token, q, folder) {
      if (q) {
        const found = await library(token, `/hubs/search?${new URLSearchParams({ query: q, limit: "10" })}`);
        return (found.Hub || []).flatMap((h) => h.Metadata || []).filter((m) => PLAYABLE.includes(m.type)).slice(0, 48).map(toItem);
      }
      if (!folder) {
        const { Directory = [] } = await library(token, "/library/sections");
        return [
          { id: "deck", title: "Continue watching", subtitle: "", kind: "folder", art: false },
          ...Directory.filter((d) => ["movie", "show", "artist"].includes(d.type))
            .map((d) => ({ id: `s${d.key}`, title: d.title, subtitle: { movie: "Movies", show: "TV shows", artist: "Music" }[d.type], kind: "folder", art: false })),
        ];
      }
      if (folder === "deck") return ((await library(token, "/library/onDeck")).Metadata || []).map(toItem);
      const section = /^s(\d+)$/.exec(folder);
      const path = section
        ? `/library/sections/${section[1]}/all?${new URLSearchParams({ sort: "addedAt:desc", "X-Plex-Container-Start": "0", "X-Plex-Container-Size": "60" })}`
        : `/library/metadata/${encodeURIComponent(folder)}/children`;
      return ((await library(token, path)).Metadata || []).map(toItem);
    },
    async start(token, itemId) {
      const [m] = (await library(token, `/library/metadata/${encodeURIComponent(itemId)}`)).Metadata || [];
      if (!m || FOLDERS.includes(m.type)) throw new Error("That can't be played.");
      const item = toItem(m);
      const session = crypto.randomUUID();
      const audio = item.kind === "audio";
      // HLS for every player; video is copied when the car can already play it
      // (no work for Plex), otherwise made into 1080p H.264. Music is made AAC.
      const params = new URLSearchParams({
        path: `/library/metadata/${m.ratingKey}`, mediaIndex: "0", partIndex: "0", protocol: "hls", fastSeek: "1", location: "lan",
        directPlay: "0", directStream: audio ? "0" : "1", directStreamAudio: audio ? "0" : "1",
        session, "X-Plex-Session-Identifier": session, "X-Plex-Client-Identifier": client, "X-Plex-Product": "Frunk", "X-Plex-Platform": "Chrome",
        ...(audio ? { musicBitrate: "320" } : { videoQuality: "100", maxVideoBitrate: "8000", videoResolution: "1920x1080", subtitles: "auto" }),
      });
      const kind = audio ? "music" : "video";
      const universal = `${base}/${kind}/:/transcode/universal`;
      // Plex's own players ask for a decision first; without it Plex refuses
      // every other start. It also says when something can't be played at all.
      const decision = (await call(`${universal}/decision?${params}`, token)).MediaContainer || {};
      if (decision.generalDecisionCode >= 2000) throw new Error(`Plex can't play that: ${decision.generalDecisionText || "no way to convert it"}.`);
      const keepAlive = setInterval(() => fetch(`${universal}/ping?session=${session}`, { headers: plexHeaders(token) }).catch(() => {}), 30_000);
      keepAlive.unref();
      return {
        title: m.type === "episode" ? m.grandparentTitle || item.title : item.title,
        subtitle: m.type === "episode" ? `${item.subtitle.slice((m.grandparentTitle || "").length + 3)} · ${m.title}` : item.subtitle, // "S1E3 · Pilot"
        kind: item.kind,
        art: item.art,
        stream: createStream({
          entry: `${universal}/start.m3u8?${params}`,
          headers: plexHeaders(token),
          stop: () => {
            clearInterval(keepAlive);
            fetch(`${universal}/stop?session=${session}`, { headers: plexHeaders(token) }).catch(() => {});
          },
        }),
      };
    },
    art: (token, itemId) => /^\d+$/.test(itemId) && fetch(`${base}/photo/:/transcode?${new URLSearchParams({ width: "400", height: "400", minSize: "1", upscale: "1", url: `/library/metadata/${itemId}/thumb` })}`, { headers: plexHeaders(token), signal: AbortSignal.timeout(15_000) }),
  };
}

// "https://a.example/x" -> ["a.example"]; nothing for an unset or bad address.
function hostnames(url) {
  try {
    return url ? [new URL(url).hostname.replace(/^www\./, "")] : [];
  } catch {
    return [];
  }
}

function createApps(env) {
  const list = [
    env.PLEX_URL && createPlex(env.PLEX_URL, env.PLEX_TV_URL, hostnames(env.PLEXDRIVE_PUBLIC_URL)),
    env.ABS_URL && createAbs(env.ABS_URL),
  ].filter(Boolean);
  return { list, byId: (id) => list.find((a) => a.id === id) || null };
}

module.exports = { createApps, createStream };
