// Apps a Watch Party can play from: servers the admin names in the
// environment (ABS_URL, ...). Each person connects their own account with a
// key; requests only ever go to the configured server, so nobody can point
// Frunk at another machine. Keys stay on the server.

// Audiobookshelf: books play through its HLS transcoder, so a book of many
// files is one stream, and every member fetches it through Frunk.
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
    host: new URL(base).hostname,
    // The account's name, or throws when the key doesn't work.
    async account(token) {
      const me = await call(token, "/api/me");
      return me.username || "your account";
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
    // A playback session on the host's account. fetch(file) serves the stream's
    // playlist and segments; stop() ends the session.
    async start(token, itemId) {
      const s = await call(token, `/api/items/${encodeURIComponent(itemId)}/play`, {
        method: "POST",
        body: { deviceInfo: { clientName: "Frunk Watch Party" }, forceTranscode: true, forceDirectPlay: false, mediaPlayer: "html5", supportedMimeTypes: [] },
      });
      const track = (s.audioTracks || [])[0];
      const dir = track && /^(\/hls\/[^/]+\/)[^/]+$/.exec(track.contentUrl);
      if (!dir) throw new Error("Audiobookshelf didn't start a stream.");
      return {
        title: s.displayTitle || "Untitled",
        subtitle: s.displayAuthor || "",
        playlist: track.contentUrl.slice(dir[1].length),
        fetch: (file) => fetch(`${base}${dir[1]}${encodeURIComponent(file)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) }),
        stop: () => call(token, `/api/session/${encodeURIComponent(s.id)}/close`, { method: "POST", body: {} }).catch(() => {}),
      };
    },
    art: (token, itemId) => fetch(`${base}/api/items/${encodeURIComponent(itemId)}/cover?width=400`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }),
  };
}

function createApps(env) {
  const list = [env.ABS_URL && createAbs(env.ABS_URL)].filter(Boolean);
  return { list, byId: (id) => list.find((a) => a.id === id) || null };
}

module.exports = { createApps };
