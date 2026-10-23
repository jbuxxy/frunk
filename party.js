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
const MAX_POSITION = 30 * 24 * 3600; // long audiobooks run well past a day
const MODES = ["host", "everyone", "copilots"];
const CHAT_KEEP = 100; // messages a newcomer (or a reload) gets to scroll back through
const CHAT_MAX_CHARS = 500;
const CHAT_BURST = { count: 8, ms: 10_000 }; // per person, messages and reactions each
const REACTIONS = ["😂", "😮", "❤️", "👏", "🔥", "😢"];
const KNOCK_MS = 2 * 60_000; // an unanswered request to join lapses after this
// Who gets in: people with a Frunk account join right away or ask; people
// without one can't, ask, or join right away (as a guest of this one party).
const ACCESS = { accounts: ["open", "ask"], guests: ["no", "ask", "open"] };
const DEFAULT_ACCESS = { accounts: "open", guests: "ask" };
const GUEST_NAME_MAX = 30;
// Push-to-talk: who may hold the button. "pilots" is the host and co-pilots.
const TALK = ["everyone", "accounts", "pilots", "nobody"];
const DEFAULT_TALK = "accounts";
const TALK_MAX_MS = 30_000; // one turn; the button has to be pressed again after
const TALK_CHUNK_MAX = 16_000; // base64 chars per chunk: 200 ms of 16 kHz μ-law is about 4,300

// The apps a host plays from, given by the server:
//   sourcesFor(userId): [{ id, name, hosts: [tile hostnames] }] that person can host from
//   browse(userId, sourceId, q, folder): what they could play, [{ id, title,
//     subtitle, kind: "video" | "audio" | "folder", art }]; folder opens one
//   start(userId, sourceId, itemId): { title, subtitle, kind, src } for a public
//     stream, or { ..., stream } for one members fetch through Frunk with the
//     host's key, which never leaves the server (apps.js createStream)
//   art(userId, sourceId, itemId): a fetch Response with the item's cover
// person(userId): { name, color } or null once the account is gone.
// carFor(sourceId, kind): whether the car player (FSP, see server.js) can play
//   this, so the Tesla gets a canvas instead of a <video> it would pause in Drive.
//
// Everyone in a party is an "identity": a Frunk account's id, or a guest's
// ("g_…") that only exists inside that party.
function createParties({ sourcesFor, browse, start, art, person, carFor = () => false }) {
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

  const isGuest = (id) => String(id).startsWith("g_");
  function who(p, id) {
    if (isGuest(id)) return { name: p.guests.get(id)?.name || "Guest", color: null, guest: true };
    return person(id) || { name: "Someone", color: null };
  }
  // In without asking: the host, anyone already let in, or the party is open to them.
  const admitted = (p, id) => !p.removed.has(id) &&
    (id === p.hostId || p.allowed.has(id) || (isGuest(id) ? p.access.guests === "open" : p.access.accounts === "open"));
  function validAccess(access, base = DEFAULT_ACCESS) {
    const next = { ...base, ...(access || {}) };
    return ACCESS.accounts.includes(next.accounts) && ACCESS.guests.includes(next.guests) ? { accounts: next.accounts, guests: next.guests } : null;
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
  // Choosing what plays: the host and co-pilots (never guests).
  const canChoose = (p, userId) => userId === p.hostId || (p.mode === "copilots" && p.copilots.has(userId) && !isGuest(userId));
  // Push-to-talk. Everyone always hears; this is who may speak.
  function canTalk(p, userId) {
    if (p.talk === "nobody") return false;
    if (p.talk === "pilots") return userId === p.hostId || (p.mode === "copilots" && p.copilots.has(userId));
    if (p.talk === "accounts") return !isGuest(userId);
    return true;
  }

  // One entry per person, even with the party open on two of their screens.
  function people(p) {
    const seen = new Map();
    for (const [id, m] of p.members) {
      if (seen.has(m.userId)) continue;
      const w = who(p, m.userId);
      seen.set(m.userId, { id, name: w.name, color: w.color, guest: !!w.guest, host: m.userId === p.hostId, copilot: p.copilots.has(m.userId) });
    }
    return [...seen.values()];
  }

  function snapshot(p, userId) {
    const host = person(p.hostId) || { name: "The host", color: null };
    return {
      code: p.code,
      host: { name: host.name, color: host.color, away: !hostHere(p) },
      mode: p.mode,
      access: p.access,
      talk: p.talk,
      talking: p.floor && { member: p.floor.memberId, name: p.floor.name, color: p.floor.color },
      people: people(p),
      state: { media: p.media, playing: p.playing, position: p.position, at: p.at },
      you: { host: userId === p.hostId, guest: isGuest(userId), control: canControl(p, userId), choose: canChoose(p, userId), talk: canTalk(p, userId) },
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
  // To every open page in the party, except (optionally) one person's own.
  function toAll(p, msg, exceptUser) {
    for (const m of p.members.values()) if (m.userId !== exceptUser) for (const res of m.streams) send(res, msg);
  }
  // The talk button let go, timed out, or the talker gone or no longer allowed.
  function releaseFloor(p) {
    if (!p.floor) return;
    clearTimeout(p.floor.timer);
    const member = p.floor.memberId;
    p.floor = null;
    toAll(p, { type: "talk-end", member });
  }
  // To the host's open pages: someone asking to join, or that being settled.
  function toHost(p, msg) {
    for (const m of p.members.values()) if (m.userId === p.hostId) for (const res of m.streams) send(res, msg);
  }
  const knock = (r) => ({ id: r.id, name: r.name, guest: r.guest });

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
    if (p.floor) clearTimeout(p.floor.timer);
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
          if (p.floor && p.floor.memberId === id) releaseFloor(p);
          changed = true;
        }
      }
      for (const r of p.requests.values()) {
        if (r.status === "waiting" && now - r.at > KNOCK_MS) {
          r.status = "expired";
          toHost(p, { type: "knock-done", id: r.id });
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
    canHost: (userId) => !isGuest(userId) && sourcesFor(userId).length > 0,
    sourcesFor,
    lobbyList,

    watchLobby(req, res, userId) {
      const entry = { res, userId };
      openStream(req, res, () => lobby.delete(entry));
      lobby.add(entry);
      send(res, { type: "lobby", parties: lobbyList(userId) });
    },

    // One party per host: hosting again returns the one already running.
    // { mode, access, talk }: the host's choices from the setup sheet.
    create(userId, { mode = "host", access, talk = DEFAULT_TALK } = {}) {
      for (const p of parties.values()) if (p.hostId === userId) return p.code;
      if (!MODES.includes(mode)) mode = "host";
      if (!TALK.includes(talk)) talk = DEFAULT_TALK;
      let code;
      do code = Array.from(crypto.randomBytes(4), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
      while (parties.has(code));
      parties.set(code, {
        code, hostId: userId, created: Date.now(), hostLeftAt: null,
        mode, copilots: new Set(), access: validAccess(access) || { ...DEFAULT_ACCESS },
        talk, floor: null, // floor: who's holding the talk button { memberId, userId, name, color, timer }
        allowed: new Set(), // identities let in, who come and go without asking again
        removed: new Set(), // identities the host removed; they can't come back
        requests: new Map(), // identity -> { id, name, guest, at, status: waiting | allowed | denied | expired }
        guests: new Map(), // guest identity -> { name }
        guestTokens: new Map(), // a guest's cookie -> their identity
        media: null, playing: false, position: 0, at: Date.now(),
        stream: null, // what's playing, server side (apps.js createStream)
        loads: 0, // so only the latest of overlapping choices wins
        members: new Map(), // memberId -> { userId, streams: Set(res), lastSeen }
        chat: [], // { id, at, name, color, text }
        sent: new Map(), // userId -> recent message/reaction times, for the burst limit
      });
      lobbyUpdate();
      return code;
    },

    // memberId: this page's earlier membership (kept across a reload), if any.
    // { member, party } once in; { waiting: true } while the host decides;
    // { error } when they can't come in; null when there's no such party.
    join(code, userId, memberId) {
      const p = find(code);
      if (!p) return null;
      if (p.removed.has(userId)) return { error: `${who(p, p.hostId).name} removed you from this party.` };
      if (!admitted(p, userId)) {
        if (isGuest(userId) && p.access.guests === "no") return { error: "This party is only for people with a Frunk account." };
        let r = p.requests.get(userId);
        if (!r || r.status !== "waiting") {
          r = { id: userId, name: who(p, userId).name, guest: isGuest(userId), at: Date.now(), status: "waiting" };
          p.requests.set(userId, r);
          toHost(p, { type: "knock", request: knock(r) });
        }
        return { waiting: true };
      }
      p.allowed.add(userId);
      let id = memberOf(p, memberId, userId) ? memberId : null;
      if (!id) {
        // A second screen of someone already here isn't news.
        const arriving = ![...p.members.values()].some((m) => m.userId === userId);
        id = crypto.randomBytes(12).toString("base64url");
        p.members.set(id, { userId, streams: new Set(), lastSeen: Date.now() });
        broadcast(p, arriving ? { kind: "joined", by: who(p, userId).name } : null);
      }
      return { member: id, party: snapshot(p, userId) };
    },

    // Where someone asking to join stands: waiting, allowed, denied, expired, or
    // removed; "ended" when the party is gone.
    requestStatus(code, userId) {
      const p = find(code);
      if (!p) return "ended";
      if (p.removed.has(userId)) return "removed";
      if (admitted(p, userId)) return "allowed";
      return p.requests.get(userId)?.status || "expired";
    },
    // Host only: { request: identity, allow }.
    answer(code, memberId, userId, { request, allow } = {}) {
      const p = find(code);
      if (!memberOf(p, memberId, userId)) return "You're not in that party.";
      if (userId !== p.hostId) return "Only the host can let people in.";
      const r = p.requests.get(request);
      if (!r || r.status !== "waiting") return "That request has already been answered.";
      r.status = allow ? "allowed" : "denied";
      if (allow) p.allowed.add(r.id);
      toHost(p, { type: "knock-done", id: r.id });
      return null;
    },

    // Someone without a Frunk account: an identity for this party only, and the
    // token their browser keeps to prove it. { error } when guests can't come.
    addGuest(code, name) {
      const p = find(code);
      if (!p) return null;
      if (p.access.guests === "no") return { error: "This party is only for people with a Frunk account." };
      name = String(name || "").trim().replace(/\s+/g, " ").slice(0, GUEST_NAME_MAX);
      if (!name) return { error: "Type your name first." };
      const id = `g_${crypto.randomBytes(9).toString("base64url")}`;
      const token = crypto.randomBytes(24).toString("base64url");
      p.guests.set(id, { name });
      p.guestTokens.set(token, id);
      return { id, token };
    },
    guestId: (code, token) => (token && find(code)?.guestTokens.get(token)) || null,
    // For the join screen of someone signed out: whose party, and can guests come.
    info(code) {
      const p = find(code);
      return p && { code: p.code, host: who(p, p.hostId).name, guests: p.access.guests };
    },

    // Host only: remove someone (a member id of theirs); they can't come back.
    remove(code, memberId, userId, { person: target } = {}) {
      const p = find(code);
      if (!memberOf(p, memberId, userId)) return "You're not in that party.";
      if (userId !== p.hostId) return "Only the host can remove people.";
      const gone = p.members.get(target)?.userId;
      if (!gone || gone === p.hostId) return "They're not in the party.";
      p.removed.add(gone);
      p.allowed.delete(gone);
      p.copilots.delete(gone);
      if (p.floor && p.floor.userId === gone) releaseFloor(p);
      for (const [id, m] of p.members) {
        if (m.userId !== gone) continue;
        for (const res of m.streams) {
          send(res, { type: "removed", by: who(p, p.hostId).name });
          res.end();
        }
        p.members.delete(id);
      }
      broadcast(p, { kind: "removed", by: who(p, gone).name });
      return null;
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
      if (m.userId === p.hostId) {
        for (const r of p.requests.values()) if (r.status === "waiting") send(res, { type: "knock", request: knock(r) });
        broadcast(p); // the host is back
      }
      return true;
    },

    // { action: "play" | "pause" | "seek" | "load", position, media: { source, id } }
    // Resolves to an error message, or null.
    async control(code, memberId, userId, { action, position, media } = {}) {
      const p = find(code);
      if (!memberOf(p, memberId, userId)) return "You're not in that party.";
      const now = Date.now();
      const by = who(p, userId).name;
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
          if (item.stream) item.stream.stop(); // overtaken by another choice, or the party ended
          return null;
        }
        stopStream(p);
        p.stream = item.stream || null;
        p.media = {
          source: source.id, id: media.id, title: item.title, subtitle: item.subtitle || "", kind: item.kind,
          src: item.stream ? `/api/party/${p.code}/stream/${load}/${item.stream.entry}` : item.src,
          art: item.art ? `/api/party/${p.code}/art/${source.id}/${encodeURIComponent(media.id)}` : null,
          car: carFor(source.id, item.kind) ? `/api/party/${p.code}/car/${load}` : null,
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

    // Host only: { mode, access, talk, copilots: [member ids] }.
    settings(code, memberId, userId, { mode, access, talk, copilots } = {}) {
      const p = find(code);
      if (!memberOf(p, memberId, userId)) return "You're not in that party.";
      if (userId !== p.hostId) return "Only the host can change that.";
      if (mode !== undefined) {
        if (!MODES.includes(mode)) return "Unknown mode.";
        p.mode = mode;
      }
      if (access !== undefined) {
        const next = validAccess(access, p.access);
        if (!next) return "Unknown setting.";
        p.access = next;
      }
      if (talk !== undefined) {
        if (!TALK.includes(talk)) return "Unknown setting.";
        p.talk = talk;
      }
      if (Array.isArray(copilots)) {
        p.copilots = new Set(copilots.map((id) => p.members.get(id)).filter(Boolean).map((m) => m.userId).filter((id) => !isGuest(id)));
        p.copilots.delete(p.hostId);
      }
      if (p.floor && !canTalk(p, p.floor.userId)) releaseFloor(p);
      broadcast(p);
      return null;
    },

    leave(code, memberId, userId) {
      const p = find(code);
      if (!memberOf(p, memberId, userId)) return;
      for (const res of p.members.get(memberId).streams) res.end();
      p.members.delete(memberId);
      if (p.floor && p.floor.memberId === memberId) releaseFloor(p);
      broadcast(p, { kind: "left", by: who(p, userId).name });
    },

    end(code, userId) {
      const p = find(code);
      if (!p) return "That party has ended.";
      if (p.hostId !== userId) return "Only the host can end the party.";
      end(p, who(p, userId).name);
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
      const w = who(p, userId);
      let msg;
      if (kind === "react") {
        if (!REACTIONS.includes(reaction)) return "Unknown reaction.";
        msg = { type: "react", reaction, name: w.name, color: w.color };
      } else {
        text = String(text || "").trim();
        if (!text) return "Type a message first.";
        if (text.length > CHAT_MAX_CHARS) return `Keep it under ${CHAT_MAX_CHARS} characters.`;
        // from: the sending screen, so someone's other screens still get notified.
        const message = { id: crypto.randomBytes(6).toString("base64url"), at: now, from: memberId, name: w.name, color: w.color, guest: !!w.guest, text };
        p.chat.push(message);
        if (p.chat.length > CHAT_KEEP) p.chat.shift();
        msg = { type: "chat", message };
      }
      p.sent.set(key, [...recent, now]);
      for (const m of p.members.values()) for (const res of m.streams) send(res, msg);
      return null;
    },

    // Push-to-talk, a walkie-talkie: { action: "start" } takes the floor (one
    // talker at a time, TALK_MAX_MS at most), { action: "audio", seq, data }
    // sends a chunk (base64 16 kHz μ-law) to everyone else, { action: "end" }
    // lets go. Everyone's screens show who's talking; the talker's own screens
    // don't play their voice back. Returns an error message, or null.
    talk(code, memberId, userId, { action, seq, data } = {}) {
      const p = find(code);
      if (!memberOf(p, memberId, userId)) return "You're not in that party.";
      if (action === "start") {
        if (!canTalk(p, userId)) return p.talk === "nobody" ? "Talking is off in this party." : "The host hasn't let you talk in this party.";
        if (p.floor && p.floor.memberId !== memberId) return `${p.floor.name} is talking.`;
        if (p.floor) clearTimeout(p.floor.timer);
        const w = who(p, userId);
        p.floor = { memberId, userId, name: w.name, color: w.color, timer: setTimeout(() => releaseFloor(p), TALK_MAX_MS) };
        p.floor.timer.unref?.();
        toAll(p, { type: "talk-start", member: memberId, name: w.name, color: w.color });
        return null;
      }
      if (action === "audio") {
        if (!p.floor || p.floor.memberId !== memberId) return "Hold the talk button first.";
        if (typeof data !== "string" || !data || data.length > TALK_CHUNK_MAX || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return "Bad audio.";
        toAll(p, { type: "talk", member: memberId, seq: Number(seq) || 0, data }, userId);
        return null;
      }
      if (action === "end") {
        if (p.floor && p.floor.memberId === memberId) releaseFloor(p);
        return null;
      }
      return "Unknown action.";
    },

    // What the host's apps offer, for someone allowed to choose. null: not allowed.
    sourcesOf(code, memberId, userId) {
      const p = find(code);
      if (!memberOf(p, memberId, userId) || !canChoose(p, userId)) return null;
      return sourcesFor(p.hostId);
    },
    async browse(code, memberId, userId, sourceId, q, folder) {
      const p = find(code);
      if (!memberOf(p, memberId, userId) || !canChoose(p, userId)) return null;
      if (!sourcesFor(p.hostId).some((s) => s.id === sourceId)) return [];
      return browse(p.hostId, sourceId, q, folder);
    },

    // Server side of what's playing, for someone in the party: a stream file
    // (load: the choice it belongs to, so a stale player can't fetch the next
    // one's files), or a cover from one of the host's apps.
    streamFor(code, userId, load) {
      const p = find(code);
      const here = p && [...p.members.values()].some((m) => m.userId === userId);
      return here && p.stream && String(p.loads) === String(load) ? p.stream : null;
    },
    // What the car player streams, for someone in the party: the title, whose key
    // plays it, and this stretch of continuous playback (segment), which changes on
    // every play, pause or seek so all the cars share one stream until then.
    carFor(code, userId, load) {
      const p = find(code);
      const here = p && [...p.members.values()].some((m) => m.userId === userId);
      if (!here || !p.media || !p.media.car || String(p.loads) !== String(load)) return null;
      return {
        hostId: p.hostId, source: p.media.source, id: p.media.id, playing: p.playing,
        segment: `${p.code}:${p.loads}:${p.at}`, position: positionOf(p),
      };
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
