// Frunk Watch Party: rooms where everyone plays the same thing in step. The
// server is the clock: a party's state is "at server time `at`, playback was at
// `position` seconds, playing or paused", and every device (the host's too)
// follows it, so a car that buffers catches up instead of holding everyone
// back. Kept in memory only; a restart ends every party.
const crypto = require("node:crypto");

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const MEMBER_GONE_MS = 60_000; // a member with no open page this long has left
const HOST_GONE_MS = 15 * 60_000; // the party ends this long after the host's last page closes
const MAX_AGE_MS = 12 * 60 * 60_000;
const MAX_POSITION = 24 * 3600;
const MODES = ["host", "everyone", "copilots"];
const CHAT_KEEP = 100; // messages a newcomer (or a reload) gets to scroll back through
const CHAT_MAX_CHARS = 500;
const CHAT_BURST = { count: 8, ms: 10_000 }; // per person, messages and reactions each
const REACTIONS = ["😂", "😮", "❤️", "👏", "🔥", "😢"];

// The apps a host plays from, given by the server:
//   sourcesFor(userId): [{ id, name, hosts: [tile hostnames] }] that person can host from
//   browse(userId, sourceId, q): what they could play, [{ id, title, subtitle, kind, art }]
//   start(userId, sourceId, itemId): { title, subtitle, kind, src } for a public
//     stream, or { ..., playlist, fetch(file), stop() } for one that members
//     fetch through Frunk (with the host's key, which never leaves the server)
//   art(userId, sourceId, itemId): a fetch Response with the item's cover
// person(userId): { name, color } or null once the account is gone.
function createParties({ sourcesFor, browse, start, art, person }) {
  const parties = new Map(); // code -> party
  const lobby = new Set(); // { res, userId }: pages showing who's hosting

  const send = (res, msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  function openStream(req, res, onClose) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no", // nginx would otherwise hold events back
    });
    res.write(": open\n\n");
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(ping);
      onClose();
    });
  }

  const positionOf = (p, at = Date.now()) => (p.playing ? p.position + (at - p.at) / 1000 : p.position);
  const hostHere = (p) => [...p.members.values()].some((m) => m.userId === p.hostId);
  const copilotHere = (p) => [...p.members.values()].some((m) => p.copilots.has(m.userId));

  // Play/pause/seek. While the host is away and no co-pilot is here, anyone may,
  // so the party isn't stuck.
  function canControl(p, userId) {
    if (userId === p.hostId || p.mode === "everyone") return true;
    if (p.mode === "copilots" && p.copilots.has(userId)) return true;
    return !hostHere(p) && !copilotHere(p);
  }
  // Choosing what plays: the host and co-pilots.
  const canChoose = (p, userId) => userId === p.hostId || (p.mode === "copilots" && p.copilots.has(userId));

  // One entry per person, even with the party open on two of their screens.
  function people(p) {
    const seen = new Map();
    for (const [id, m] of p.members) {
      if (seen.has(m.userId)) continue;
      const who = person(m.userId) || { name: "Someone", color: null };
      seen.set(m.userId, { id, name: who.name, color: who.color, host: m.userId === p.hostId, copilot: p.copilots.has(m.userId) });
    }
    return [...seen.values()];
  }

  function snapshot(p, userId) {
    const host = person(p.hostId) || { name: "The host", color: null };
    return {
      code: p.code,
      host: { name: host.name, color: host.color, away: !hostHere(p) },
      mode: p.mode,
      people: people(p),
      state: { media: p.media, playing: p.playing, position: p.position, at: p.at },
      you: { host: userId === p.hostId, control: canControl(p, userId), choose: canChoose(p, userId) },
    };
  }

  // event: what just happened, for a toast ({ kind, by }); null for quiet updates.
  function broadcast(p, event = null) {
    for (const m of p.members.values()) {
      if (!m.streams.size) continue;
      const msg = { type: "party", party: snapshot(p, m.userId), event };
      for (const res of m.streams) send(res, msg);
    }
    lobbyUpdate();
  }

  function lobbyList(userId) {
    return [...parties.values()].map((p) => {
      const host = person(p.hostId) || { name: "Someone", color: null };
      return { code: p.code, host: { name: host.name, color: host.color }, title: p.media ? p.media.title : null, people: people(p).length, mine: p.hostId === userId };
    });
  }
  function lobbyUpdate() {
    for (const l of lobby) send(l.res, { type: "lobby", parties: lobbyList(l.userId) });
  }

  function find(code) {
    return parties.get(String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "")) || null;
  }
  // The member, if it belongs to this person.
  function memberOf(p, memberId, userId) {
    const m = p && p.members.get(memberId);
    return m && m.userId === userId ? m : null;
  }

  function stopStream(p) {
    if (p.stream && p.stream.stop) p.stream.stop();
    p.stream = null;
  }

  function end(p, by) {
    parties.delete(p.code);
    stopStream(p);
    for (const m of p.members.values()) {
      for (const res of m.streams) {
        send(res, { type: "ended", by });
        res.end();
      }
    }
    lobbyUpdate();
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const p of parties.values()) {
      let changed = false;
      for (const [id, m] of p.members) {
        if (!m.streams.size && now - m.lastSeen > MEMBER_GONE_MS) {
          p.members.delete(id);
          changed = true;
        }
      }
      if (hostHere(p)) p.hostLeftAt = null;
      else p.hostLeftAt ||= now;
      if (now - p.created > MAX_AGE_MS || (p.hostLeftAt && now - p.hostLeftAt > HOST_GONE_MS) || !person(p.hostId)) end(p, null);
      else if (changed) broadcast(p);
    }
  }, 10_000);
  sweeper.unref();

  return {
    canHost: (userId) => sourcesFor(userId).length > 0,
    sourcesFor,
    lobbyList,

    watchLobby(req, res, userId) {
      const entry = { res, userId };
      openStream(req, res, () => lobby.delete(entry));
      lobby.add(entry);
      send(res, { type: "lobby", parties: lobbyList(userId) });
    },

    // One party per host: hosting again returns the one already running.
    create(userId) {
      for (const p of parties.values()) if (p.hostId === userId) return p.code;
      let code;
      do code = Array.from(crypto.randomBytes(4), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
      while (parties.has(code));
      parties.set(code, {
        code, hostId: userId, created: Date.now(), hostLeftAt: null,
        mode: "host", copilots: new Set(),
        media: null, playing: false, position: 0, at: Date.now(),
        stream: null, // what's playing, server side: { sourceId, itemId, fetch, stop }
        loads: 0, // so only the latest of overlapping choices wins
        members: new Map(), // memberId -> { userId, streams: Set(res), lastSeen }
        chat: [], // { id, at, name, color, text }
        sent: new Map(), // userId -> recent message/reaction times, for the burst limit
      });
      lobbyUpdate();
      return code;
    },

    // memberId: this page's earlier membership (kept across a reload), if any.
    join(code, userId, memberId) {
      const p = find(code);
      if (!p) return null;
      let id = memberOf(p, memberId, userId) ? memberId : null;
      if (!id) {
        // A second screen of someone already here isn't news.
        const arriving = ![...p.members.values()].some((m) => m.userId === userId);
        id = crypto.randomBytes(12).toString("base64url");
        p.members.set(id, { userId, streams: new Set(), lastSeen: Date.now() });
        broadcast(p, arriving ? { kind: "joined", by: (person(userId) || {}).name } : null);
      }
      return { member: id, party: snapshot(p, userId) };
    },

    stream(code, memberId, userId, req, res) {
      const p = find(code);
      const m = memberOf(p, memberId, userId);
      if (!m) return false;
      openStream(req, res, () => {
        m.streams.delete(res);
        m.lastSeen = Date.now();
      });
      m.streams.add(res);
      m.lastSeen = Date.now();
      send(res, { type: "party", party: snapshot(p, userId), event: null });
      send(res, { type: "chat-history", messages: p.chat });
      if (m.userId === p.hostId) broadcast(p); // the host is back
      return true;
    },

    // { action: "play" | "pause" | "seek" | "load", position, media: { source, id } }
    // Resolves to an error message, or null.
    async control(code, memberId, userId, { action, position, media } = {}) {
      const p = find(code);
      if (!memberOf(p, memberId, userId)) return "You're not in that party.";
      const now = Date.now();
      const by = (person(userId) || {}).name;
      if (action === "load") {
        if (!canChoose(p, userId)) return "Only the host can choose what plays.";
        const source = sourcesFor(p.hostId).find((s) => s.id === (media && media.source));
        if (!source || typeof media.id !== "string") return "That isn't available.";
        const load = ++p.loads;
        let item;
        try {
          item = await start(p.hostId, source.id, media.id);
        } catch (err) {
          return err.message || "That couldn't be started.";
        }
        if (load !== p.loads || parties.get(p.code) !== p) {
          if (item.stop) item.stop(); // overtaken by another choice, or the party ended
          return null;
        }
        stopStream(p);
        p.stream = item.fetch ? { sourceId: source.id, itemId: media.id, fetch: item.fetch, stop: item.stop } : null;
        p.media = {
          source: source.id, id: media.id, title: item.title, subtitle: item.subtitle || "", kind: item.kind,
          src: item.fetch ? `/api/party/${p.code}/stream/${load}/${item.playlist}` : item.src,
          art: item.art ? `/api/party/${p.code}/art/${source.id}/${encodeURIComponent(media.id)}` : null,
        };
        Object.assign(p, { playing: true, position: 0, at: now });
        broadcast(p, { kind: "load", by });
        return null;
      }
      if (!canControl(p, userId)) return "The host is controlling playback.";
      if (!p.media) return "Nothing is playing yet.";
      const pos = position === undefined ? positionOf(p, now) : Number(position);
      if (!Number.isFinite(pos) || pos < 0 || pos > MAX_POSITION) return "Invalid position.";
      if (action === "play") Object.assign(p, { playing: true, position: pos, at: now });
      else if (action === "pause") Object.assign(p, { playing: false, position: pos, at: now });
      else if (action === "seek") Object.assign(p, { position: pos, at: now });
      else return "Unknown action.";
      broadcast(p, { kind: action, by });
      return null;
    },

    // Host only: { mode, copilots: [member ids] }.
    settings(code, memberId, userId, { mode, copilots } = {}) {
      const p = find(code);
      if (!memberOf(p, memberId, userId)) return "You're not in that party.";
      if (userId !== p.hostId) return "Only the host can change that.";
      if (mode !== undefined) {
        if (!MODES.includes(mode)) return "Unknown mode.";
        p.mode = mode;
      }
      if (Array.isArray(copilots)) {
        p.copilots = new Set(copilots.map((id) => p.members.get(id)).filter(Boolean).map((m) => m.userId));
        p.copilots.delete(p.hostId);
      }
      broadcast(p);
      return null;
    },

    leave(code, memberId, userId) {
      const p = find(code);
      if (!memberOf(p, memberId, userId)) return;
      for (const res of p.members.get(memberId).streams) res.end();
      p.members.delete(memberId);
      broadcast(p, { kind: "left", by: (person(userId) || {}).name });
    },

    end(code, userId) {
      const p = find(code);
      if (!p) return "That party has ended.";
      if (p.hostId !== userId) return "Only the host can end the party.";
      end(p, (person(userId) || {}).name);
      return null;
    },

    // Chat: text, or a reaction (one of REACTIONS) that floats over everyone's
    // video and isn't kept. Returns an error message, or null.
    chat(code, memberId, userId, { text, reaction } = {}) {
      const p = find(code);
      if (!memberOf(p, memberId, userId)) return "You're not in that party.";
      const now = Date.now();
      const kind = reaction !== undefined ? "react" : "chat";
      const key = `${userId} ${kind}`;
      const recent = (p.sent.get(key) || []).filter((t) => now - t < CHAT_BURST.ms);
      if (recent.length >= CHAT_BURST.count) return "Slow down a little.";
      const who = person(userId) || { name: "Someone", color: null };
      let msg;
      if (kind === "react") {
        if (!REACTIONS.includes(reaction)) return "Unknown reaction.";
        msg = { type: "react", reaction, name: who.name, color: who.color };
      } else {
        text = String(text || "").trim();
        if (!text) return "Type a message first.";
        if (text.length > CHAT_MAX_CHARS) return `Keep it under ${CHAT_MAX_CHARS} characters.`;
        const message = { id: crypto.randomBytes(6).toString("base64url"), at: now, name: who.name, color: who.color, text };
        p.chat.push(message);
        if (p.chat.length > CHAT_KEEP) p.chat.shift();
        msg = { type: "chat", message };
      }
      p.sent.set(key, [...recent, now]);
      for (const m of p.members.values()) for (const res of m.streams) send(res, msg);
      return null;
    },

    // What the host's apps offer, for someone allowed to choose. null: not allowed.
    sourcesOf(code, memberId, userId) {
      const p = find(code);
      if (!memberOf(p, memberId, userId) || !canChoose(p, userId)) return null;
      return sourcesFor(p.hostId);
    },
    async browse(code, memberId, userId, sourceId, q) {
      const p = find(code);
      if (!memberOf(p, memberId, userId) || !canChoose(p, userId)) return null;
      if (!sourcesFor(p.hostId).some((s) => s.id === sourceId)) return [];
      return browse(p.hostId, sourceId, q);
    },

    // Server side of what's playing, for someone in the party: a stream file
    // (load: the choice it belongs to, so a stale player can't fetch the next
    // one's files), or a cover from one of the host's apps.
    streamFor(code, userId, load) {
      const p = find(code);
      const here = p && [...p.members.values()].some((m) => m.userId === userId);
      return here && p.stream && String(p.loads) === String(load) ? p.stream : null;
    },
    artFor(code, userId, sourceId, itemId) {
      const p = find(code);
      const here = p && [...p.members.values()].some((m) => m.userId === userId);
      if (!here || !sourcesFor(p.hostId).some((s) => s.id === sourceId)) return null;
      return art(p.hostId, sourceId, itemId);
    },
  };
}

module.exports = { createParties };
