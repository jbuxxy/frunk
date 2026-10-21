// Frunk — Watch Party: Host and Join in the top bar, the party screen, and
// playback kept in step with everyone else. The server holds the party's
// clock ("at server time `at`, playback was at `position`"); this page follows
// it, nudging its speed for small drift and seeking for large.
(() => {
  const f = window.frunk; // helpers shared by app.js
  const $ = (id) => document.getElementById(id);
  const view = $("party");
  const video = $("partyVideo");

  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { sessionStorage.removeItem(k); } catch {} },
  };

  let me = null;
  let sources = []; // apps this person can host from
  let lobby = []; // parties running now: { code, host, title, people, mine }
  let session = null; // { code, member }: the party this page is in
  let party = null; // the latest snapshot from the server
  let events = null;
  let lastAction = 0; // when this page last sent a control, so its own echo isn't toasted

  // ---------- Clock ----------
  // Offset to the server's clock from the quickest of a few round trips.
  let offset = 0;
  let clockSynced = 0;
  async function syncClock() {
    let best = null;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const { now } = await f.api("/api/party/time");
      const t1 = Date.now();
      if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: now - (t0 + t1) / 2 };
    }
    offset = best.offset;
    clockSynced = Date.now();
  }
  const serverNow = () => Date.now() + offset;
  function target() {
    const s = party.state;
    return s.playing ? s.position + (serverNow() - s.at) / 1000 : s.position;
  }

  // ---------- Top bar: Host / Join ----------
  // In the car, a party only works in fullscreen (the rear screen and driving
  // depend on it), so Host and Join go there first and come back.
  const needsFullscreen = () => f.isTesla && !f.inFullscreen;
  const viaFullscreen = (query) => location.assign(`https://www.youtube.com/redirect?q=${encodeURIComponent(`${location.origin}/?fs=1&${query}`)}`);

  function renderBar() {
    const mine = lobby.find((p) => p.mine);
    const others = lobby.filter((p) => !p.mine);
    const join = $("partyJoinBtn");
    join.hidden = !me || !!session || (!mine && !others.length);
    if (!join.hidden) {
      const one = mine || (others.length === 1 && others[0]);
      $("partyJoinText").textContent = mine ? "Your party · Rejoin" : one ? `${one.host.name} is hosting · Join` : `${others.length} parties · Join`;
      $("partyJoinDot").style.background = (one && one.host.color) || "var(--green)";
    }
    $("partyHostBtn").hidden = !me || !!session || !!mine || !sources.length;
  }

  $("partyHostBtn").onclick = () => (needsFullscreen() ? viaFullscreen("host=1") : host());
  $("partyJoinBtn").onclick = () => {
    const mine = lobby.find((p) => p.mine);
    const others = lobby.filter((p) => !p.mine);
    if (mine || others.length === 1) return joinFlow((mine || others[0]).code);
    openPartyList();
  };
  function joinFlow(code) {
    if (needsFullscreen()) return viaFullscreen(`party=${encodeURIComponent(code)}`);
    return join(code);
  }

  function openPartyList() {
    const list = $("partyList");
    list.replaceChildren(...lobby.filter((p) => !p.mine).map((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill party-row";
      b.append(dot(p.host), `${p.host.name}${p.title ? ` · ${p.title}` : ""}`);
      b.onclick = () => {
        $("partyListDialog").close();
        joinFlow(p.code);
      };
      return b;
    }));
    $("partyListDialog").showModal();
  }

  function dot(who) {
    const el = document.createElement("span");
    el.className = "party-dot";
    f.paintAvatar(el, who.color || "#3e6ae1", who.name);
    return el;
  }

  function watchLobby() {
    const es = new EventSource("/api/party/lobby");
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type !== "lobby") return;
      lobby = msg.parties;
      renderBar();
    };
  }

  // ---------- Hosting and joining ----------
  async function host() {
    try {
      const { code } = await f.api("/api/party", { method: "POST", body: "{}" });
      await join(code);
      if (party && party.you.choose && !party.state.media) openPicker();
    } catch (err) {
      f.toast(err.message, 4000);
    }
  }

  async function join(code, { quiet = false } = {}) {
    const saved = store.get("frunk-party");
    let r;
    try {
      r = await f.api(`/api/party/${encodeURIComponent(code)}/join`, {
        method: "POST",
        body: JSON.stringify({ member: saved && saved.code === code ? saved.member : undefined }),
      });
    } catch (err) {
      if (saved && saved.code === code) store.del("frunk-party");
      if (!quiet) f.toast(err.message, 4000);
      return;
    }
    session = { code: r.party.code, member: r.member };
    store.set("frunk-party", session);
    if (!clockSynced) await syncClock().catch(() => {});
    openEvents();
    show(true);
    update(r.party);
    f.render(); // lock the tiles that can't be part of a party
    renderBar();
  }

  function openEvents() {
    if (events) events.close();
    const es = new EventSource(`/api/party/${session.code}/events/${session.member}`);
    events = es;
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "party") update(msg.party, msg.event);
      else if (msg.type === "ended") finish(msg.by ? `${msg.by} ended the party.` : "The party has ended.");
    };
    // Closed for good (the server said no): rejoin, which also tells us if it ended.
    es.onerror = () => {
      if (es !== events || es.readyState !== EventSource.CLOSED) return;
      const code = session && session.code;
      events = null;
      if (code) join(code, { quiet: true }).then(() => { if (!session || !events) finish("The party has ended."); });
    };
  }

  // Back to the home screen as it was.
  function finish(message) {
    if (events) events.close();
    events = null;
    session = null;
    party = null;
    store.del("frunk-party");
    unload();
    view.hidden = true;
    document.body.classList.remove("in-party");
    for (const id of ["partyPicker", "partySettings", "partyInvite"]) if ($(id).open) $(id).close();
    f.render();
    renderBar();
    if (message) f.toast(message, 4000);
  }

  async function leave() {
    const s = session;
    finish();
    if (s) await f.api(`/api/party/${s.code}/leave`, { method: "POST", body: JSON.stringify({ member: s.member }) }).catch(() => {});
  }

  // ---------- Party screen ----------
  // Full screen, or minimized to a corner so the home screen is usable.
  function show(full) {
    view.hidden = false;
    view.classList.toggle("mini", !full);
    document.body.classList.add("in-party");
    wake();
  }
  $("partyMinimize").onclick = () => show(false);
  $("partyExpand").onclick = () => show(true);

  const NOTES = {
    joined: (by) => `${by} joined`,
    left: (by) => `${by} left`,
    play: (by) => `${by} pressed play`,
    pause: (by) => `${by} paused`,
    seek: (by) => `${by} skipped`,
    load: (by) => `${by} started ${party.state.media ? party.state.media.title : "something"}`,
  };

  function update(snapshot, event) {
    party = snapshot;
    render();
    loadMedia(party.state.media);
    sync();
    if (event && event.by && NOTES[event.kind] && (Date.now() - lastAction > 1500 || ["joined", "left"].includes(event.kind))) {
      f.toast(NOTES[event.kind](event.by));
    }
  }

  function render() {
    const { you, state, host: h } = party;
    $("partyTitle").textContent = state.media ? state.media.title : "Watch Party";
    $("partyCode").textContent = party.code;
    $("partyPeople").replaceChildren(...party.people.map((p) => {
      const el = dot(p);
      el.title = p.name + (p.host ? " (host)" : p.copilot ? " (co-pilot)" : "");
      el.classList.toggle("host", p.host);
      return el;
    }));
    $("partyLeave").textContent = you.host ? "End party" : "Leave";
    $("partySettingsBtn").hidden = !you.host;
    $("partyChoose").hidden = !you.choose || !state.media;
    $("partyEmpty").hidden = !!state.media;
    $("partyEmptyText").textContent = you.choose ? "Pick something for everyone to watch." : `${h.name} is choosing what to play…`;
    $("partyEmptyChoose").hidden = !you.choose;
    $("partyAway").hidden = !h.away || you.host;
    $("partyAway").textContent = `${h.name} stepped away. ${you.control ? "You can pause and play until they're back." : ""}`;
    for (const id of ["partyPlay", "partyBack", "partyFwd", "partySeek"]) $(id).disabled = !you.control || !state.media;
    $("partyPlay").classList.toggle("playing", state.playing);
    $("partyPlay").setAttribute("aria-label", state.playing ? "Pause" : "Play");
    $("partyWho").textContent = you.control ? "" : `${h.name} controls playback`;
    $("partyMiniTitle").textContent = state.media ? state.media.title : `${h.name}'s party`;
    if ($("partySettings").open) renderSettings(); // people come and go while it's open
  }

  // Controls hide after a few seconds of playback, and come back on a touch.
  let idleTimer = null;
  function wake() {
    view.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (party && party.state.playing) view.classList.add("idle"); }, 4000);
  }
  view.addEventListener("pointerdown", wake);

  // ---------- Controls ----------
  async function control(action, extra = {}) {
    lastAction = Date.now();
    try {
      await f.api(`/api/party/${session.code}/control`, { method: "POST", body: JSON.stringify({ member: session.member, action, ...extra }) });
    } catch (err) {
      f.toast(err.message, 4000);
    }
  }
  const here = () => Math.max(0, video.readyState ? video.currentTime : target());
  $("partyPlay").onclick = () => control(party.state.playing ? "pause" : "play", { position: here() });
  $("partyBack").onclick = () => control("seek", { position: Math.max(0, target() - 10) });
  $("partyFwd").onclick = () => control("seek", { position: target() + 10 });
  let scrubbing = false;
  $("partySeek").oninput = () => {
    scrubbing = true;
    $("partyTime").textContent = times(Number($("partySeek").value));
  };
  $("partySeek").onchange = () => {
    scrubbing = false;
    control("seek", { position: Number($("partySeek").value) });
  };
  $("partyLeave").onclick = () => {
    if (!party.you.host) return leave();
    ask("End the party?", "Everyone's playback stops.", "End party", async () => {
      const s = session;
      finish();
      await f.api(`/api/party/${s.code}/end`, { method: "POST", body: "{}" }).catch(() => {});
    });
  };
  // Autoplay with sound can need a tap (after a reload, say).
  $("partyTapToPlay").onclick = () => {
    $("partyTapToPlay").hidden = true;
    blocked = false;
    video.play().catch(() => {});
  };

  // ---------- Playback ----------
  let hls = null;
  let loadedSrc = null;
  let hlsReady = null;
  let blocked = false;
  let lastSeek = 0;
  function loadHls() {
    hlsReady ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `/vendor/hls.min.js?v=${f.assetV}`;
      script.onload = resolve;
      script.onerror = () => {
        hlsReady = null;
        reject(new Error("Couldn't load the video player. Try again."));
      };
      document.head.append(script);
    });
    return hlsReady;
  }
  function unload() {
    loadedSrc = null;
    if (hls) hls.destroy();
    hls = null;
    video.removeAttribute("src");
    video.load();
  }
  async function loadMedia(media) {
    const src = media ? media.src : null;
    if (src === loadedSrc) return;
    unload();
    loadedSrc = src;
    if (!src) return;
    // HLS: the browser's own player where it has one (iPhone), else hls.js.
    if (/\.m3u8(\?|$)/.test(src) && !video.canPlayType("application/vnd.apple.mpegurl")) {
      try {
        await loadHls();
      } catch (err) {
        return f.toast(err.message, 5000);
      }
      if (loadedSrc !== src) return;
      if (!window.Hls.isSupported()) return f.toast("This browser can't play this video.", 5000);
      hls = new window.Hls({ enableWorker: false });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      video.src = src;
    }
  }

  // Twice a second: match the party's clock.
  function sync() {
    if (!party || !party.state.media || video.readyState < 1) return showTime();
    const s = party.state;
    let want = target();
    if (Number.isFinite(video.duration)) want = Math.min(want, video.duration);
    if (!s.playing) {
      if (!video.paused) video.pause();
      video.playbackRate = 1;
      if (Math.abs(video.currentTime - want) > 0.25 && !video.seeking) video.currentTime = want;
      return showTime();
    }
    if (video.ended) return showTime();
    if (video.paused && !blocked) {
      video.play().catch((err) => {
        if (err.name !== "NotAllowedError") return;
        blocked = true;
        $("partyTapToPlay").hidden = false;
      });
    }
    const drift = video.currentTime - want;
    if (Math.abs(drift) > 1.5) {
      // Far off (just joined, buffered, someone skipped): jump, a little ahead
      // to cover the seek itself; not again until that one has landed.
      if (!video.seeking && Date.now() - lastSeek > 3000) {
        lastSeek = Date.now();
        video.playbackRate = 1;
        video.currentTime = want + 0.3;
      }
    } else if (Math.abs(drift) > 0.15) {
      // Ease back in step: up to 10% faster or slower (the browser keeps the pitch).
      video.playbackRate = 1 - Math.max(-0.1, Math.min(0.1, drift * 0.25));
    } else {
      video.playbackRate = 1;
    }
    showTime();
  }
  setInterval(sync, 500);
  setInterval(() => { if (session && Date.now() - clockSynced > 5 * 60_000) syncClock().catch(() => {}); }, 60_000);

  const clock = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  };
  const times = (at) => `${clock(at)}${Number.isFinite(video.duration) ? ` / ${clock(video.duration)}` : ""}`;
  function showTime() {
    if (!party || !party.state.media || scrubbing) return;
    const at = target();
    const seek = $("partySeek");
    if (Number.isFinite(video.duration)) seek.max = video.duration;
    seek.value = at;
    $("partyTime").textContent = times(at);
  }

  // ---------- Choosing what plays ----------
  // only: an app's id, when opened from that app's tile.
  async function openPicker(only) {
    let list;
    try {
      list = await f.api(`/api/party/${session.code}/sources/${session.member}`);
    } catch (err) {
      return f.toast(err.message, 4000);
    }
    const box = $("partyPickList");
    box.replaceChildren();
    for (const source of list.filter((s) => !only || s.id === only)) {
      const label = document.createElement("div");
      label.className = "field-label";
      label.textContent = source.name;
      box.append(label);
      for (const item of source.items) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pill party-row";
        b.textContent = item.title;
        b.onclick = () => {
          $("partyPicker").close();
          control("load", { media: { source: source.id, id: item.id } });
        };
        box.append(b);
      }
    }
    $("partyPicker").showModal();
  }
  $("partyChoose").onclick = () => openPicker();
  $("partyEmptyChoose").onclick = () => openPicker();

  // ---------- Who can control (host) ----------
  function renderSettings() {
    for (const b of document.querySelectorAll("#partyModes [data-mode]")) b.classList.toggle("on", b.dataset.mode === party.mode);
    const box = $("partyCopilots");
    box.hidden = party.mode !== "copilots";
    const guests = party.people.filter((p) => !p.host);
    box.replaceChildren(...(guests.length ? guests.map((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `pill party-row${p.copilot ? " on" : ""}`;
      b.append(dot(p), p.name, Object.assign(document.createElement("span"), { className: "party-tag", textContent: p.copilot ? "Co-pilot" : "Tap to make co-pilot" }));
      b.onclick = () => {
        const ids = guests.filter((g) => (g === p ? !g.copilot : g.copilot)).map((g) => g.id);
        saveSettings({ copilots: ids });
      };
      return b;
    }) : [Object.assign(document.createElement("p"), { className: "hint", textContent: "Nobody else has joined yet." })]));
  }
  async function saveSettings(body) {
    try {
      await f.api(`/api/party/${session.code}/settings`, { method: "POST", body: JSON.stringify({ member: session.member, ...body }) });
    } catch (err) {
      f.toast(err.message, 4000);
    }
  }
  for (const b of document.querySelectorAll("#partyModes [data-mode]")) b.onclick = () => saveSettings({ mode: b.dataset.mode });
  $("partySettingsBtn").onclick = () => {
    renderSettings();
    $("partySettings").showModal();
  };

  // ---------- Inviting ----------
  $("partyInviteBtn").onclick = async () => {
    const link = `${location.origin}/?party=${party.code}`;
    $("partyInviteCode").textContent = party.code;
    $("partyInviteHost").textContent = `${location.host}/join`;
    $("partyShare").textContent = navigator.share ? "Share link" : "Copy link";
    $("partyShare").onclick = () => (navigator.share
      ? navigator.share({ title: "Join my Watch Party", url: link }).catch(() => {})
      : f.copyText(link, "Party link copied", "Copy this party link:"));
    $("partyInvite").showModal();
    try {
      await f.loadQr();
      const qr = qrcode(0, "M");
      qr.addData(link);
      qr.make();
      $("partyInviteQr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
    } catch {}
  };

  // Joining by code, from /join on a phone.
  $("partyCodeForm").onsubmit = (e) => {
    e.preventDefault();
    const code = $("partyCodeForm").code.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 4) return;
    $("partyCodeDialog").close();
    joinFlow(code);
  };

  // ---------- A small confirm sheet ----------
  function ask(title, text, okLabel, onOk) {
    $("partyConfirmTitle").textContent = title;
    $("partyConfirmText").textContent = text;
    $("partyConfirmOk").textContent = okLabel;
    $("partyConfirmOk").onclick = () => {
      $("partyConfirm").close();
      onOk();
    };
    $("partyConfirm").showModal();
  }

  // ---------- Home screen tiles during a party ----------
  // Apps that can play in the party get a badge and open the picker; the rest
  // are dimmed and ask before leaving the party.
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const sourceFor = (site) => sources.find((s) => s.hosts.includes(hostOf(site.url)));
  f.party = {
    tileState(site) {
      if (!session) return null;
      return sourceFor(site) ? "party" : "locked";
    },
    // True when the party took care of the tap.
    tap(site) {
      if (!session || !party) return false;
      const source = sourceFor(site);
      if (source) {
        if (party.you.choose) openPicker(source.id);
        else f.toast(`${party.host.name} is choosing what to play`);
        return true;
      }
      const note = party.you.host ? "Everyone else keeps watching. Come back any time from the Rejoin button." : "You can rejoin from the top bar.";
      ask(`${site.name} can't be watched in the party`, `Leave the party to open it? ${note}`, "Leave party", async () => {
        await leave();
        f.launch(site);
      });
      return true;
    },

    // Called by app.js once it knows who's signed in.
    async start(user) {
      me = user;
      if (!me) {
        // A party link opened signed out: remember it through sign-in.
        const code = f.params.get("party");
        if (code) {
          store.set("frunk-party-pending", code);
          history.replaceState(null, "", "/");
          f.openSignIn("", "Sign in to join the Watch Party.");
        }
        return;
      }
      sources = await f.api("/api/party/sources").catch(() => []);
      watchLobby();
      renderBar();
      const code = f.params.get("party") || store.get("frunk-party-pending");
      const hosting = f.params.get("host") === "1";
      if (f.params.get("party") || f.params.get("host")) history.replaceState(null, "", "/");
      store.del("frunk-party-pending");
      const saved = store.get("frunk-party");
      if (location.pathname === "/join") {
        history.replaceState(null, "", "/");
        $("partyCodeForm").reset();
        $("partyCodeDialog").showModal();
      } else if (code) {
        joinFlow(code);
      } else if (hosting) {
        host();
      } else if (saved) {
        join(saved.code, { quiet: true }); // after a reload or the fullscreen trip
      }
    },
  };
})();
