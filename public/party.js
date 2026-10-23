// Frunk — Watch Party: Host and Join in the top bar, the party screen, and
// playback kept in step with everyone else. The server holds the party's
// clock ("at server time `at`, playback was at `position`"); this page follows
// it, nudging its speed for small drift and seeking for large.
(() => {
  const f = window.frunk; // helpers shared by app.js
  const $ = (id) => document.getElementById(id);
  const view = $("party");
  const video = $("partyVideo");
  const car = window.frunkCar; // the canvas player for Plex parties in the Tesla
  car.onBlocked = () => { $("partyTapToPlay").hidden = false; };
  const duration = () => (car.active ? car.duration : video.duration);

  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { sessionStorage.removeItem(k); } catch {} },
    // Kept between visits: the host's party choices, a guest's name, chat sound.
    lget(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    lset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
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
  // In the car, fullscreen is a choice, not a step: for watching while parked, and
  // so the rear screen can join (Join Front Display) and keep watching and
  // controlling while the front is driving. The party screen's Fullscreen button
  // goes there through YouTube's redirect and comes straight back into the party.
  const viaFullscreen = (query) => location.assign(`https://www.youtube.com/redirect?q=${encodeURIComponent(`${location.origin}/?fs=1&${query}`)}`);
  $("partyFullscreen").hidden = !(f.isTesla && !f.inFullscreen);
  $("partyFullscreen").onclick = () => {
    if (!session) return;
    const go = () => viaFullscreen(`party=${encodeURIComponent(session.code)}`);
    // The car's mic is off in fullscreen: say so first to anyone who could talk.
    if (party && party.you.talk && party.talk !== "nobody") {
      return ask("Go fullscreen?", "Tesla turns the microphone off in fullscreen, so Talk won't work there. You'll still hear everyone.", "Go fullscreen", go);
    }
    go();
  };

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

  $("partyHostBtn").onclick = () => host();
  $("partyJoinBtn").onclick = () => {
    const mine = lobby.find((p) => p.mine);
    const others = lobby.filter((p) => !p.mine);
    if (mine || others.length === 1) return join((mine || others[0]).code);
    openPartyList();
  };

  function openPartyList() {
    const list = $("partyList");
    list.replaceChildren(...lobby.filter((p) => !p.mine).map((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill party-row";
      b.append(dot(p.host), `${p.host.name}${p.title ? ` · ${p.title}` : ""}`);
      b.onclick = () => {
        $("partyListDialog").close();
        join(p.code);
      };
      return b;
    }));
    $("partyListDialog").showModal();
  }

  function dot(who) {
    const el = document.createElement("span");
    el.className = "party-dot";
    f.paintAvatar(el, who.color || (who.guest ? "#5f6670" : "#3e6ae1"), who.name); // guests are grey
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

  // ---------- Party choices: who can join, who controls ----------
  // The same choices make up the setup sheet (before hosting) and the party's
  // settings (sliders icon). values: { accounts, guests, mode }.
  // Guests: people without a Frunk account. Co-pilots: people the host picks
  // who can also play, pause, skip and choose what plays.
  const CHOICES = [
    { key: "accounts", label: "Frunk accounts", options: [["open", "Join"], ["ask", "Ask me"]] },
    { key: "guests", label: "Guests", options: [["no", "Blocked"], ["ask", "Ask me"], ["open", "Join"]] },
    { key: "mode", label: "Controls playback", options: [["host", "Me"], ["everyone", "Everyone"], ["copilots", "Co-pilots"]] },
    { key: "talk", label: "Can talk", options: [["everyone", "Everyone"], ["accounts", "Accounts"], ["pilots", "Me & co-pilots"], ["nobody", "Nobody"]] },
  ];
  const DEFAULT_CHOICES = { accounts: "open", guests: "ask", mode: "host", talk: "accounts" };
  // after: { key: () => elements } shown right under that choice's row.
  function renderChoices(box, values, onPick, after = {}) {
    box.replaceChildren(...CHOICES.flatMap(({ key, label, options }) => {
      const title = Object.assign(document.createElement("div"), { className: "field-label", textContent: label });
      const row = document.createElement("div");
      row.className = "party-choice";
      for (const [value, text] of options) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `pill small${values[key] === value ? " on" : ""}`;
        b.textContent = text;
        b.onclick = () => onPick(key, value);
        row.append(b);
      }
      return [title, row, ...(after[key] ? after[key]() : [])];
    }));
  }
  const hintEl = (text) => Object.assign(document.createElement("p"), { className: "hint choice-note", textContent: text });

  // ---------- Hosting and joining ----------
  // Hosting starts with the setup sheet; Frunk remembers the choices.
  function host() {
    let values = { ...DEFAULT_CHOICES, ...store.lget("frunk-party-choices") };
    const paint = () => renderChoices($("partySetupChoices"), values, (key, value) => {
      values = { ...values, [key]: value };
      paint();
    }, {
      mode: () => (values.mode === "copilots" ? [hintEl("Pick them in Party settings once they've joined. Co-pilots need a Frunk account.")] : []),
    });
    paint();
    $("partySetupStart").onclick = () => f.pressed($("partySetupStart"), async () => {
      store.lset("frunk-party-choices", values);
      const { code } = await f.api("/api/party", {
        method: "POST",
        body: JSON.stringify({ mode: values.mode, talk: values.talk, access: { accounts: values.accounts, guests: values.guests } }),
      });
      $("partySetup").close();
      await join(code);
      if (party && party.you.choose && !party.state.media) openPicker();
    });
    $("partySetup").showModal();
  }

  // hostName: for the waiting screen, if someone has to let us in.
  async function join(code, { quiet = false, hostName } = {}) {
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
    if (r.waiting) return waitFor(code, hostName || (lobby.find((x) => x.code === code) || {}).host?.name);
    await enter(r);
  }

  async function enter(r) {
    session = { code: r.party.code, member: r.member };
    store.set("frunk-party", session);
    if (!clockSynced) await syncClock().catch(() => {});
    openEvents();
    show(true);
    update(r.party);
    chatForLayout();
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
      else if (msg.type === "chat-history") showHistory(msg.messages);
      else if (msg.type === "chat") addMessage(msg.message);
      else if (msg.type === "react") floatReaction(msg);
      else if (msg.type === "ended") finish(msg.by ? `${msg.by} ended the party.` : "The party has ended.");
      else if (msg.type === "removed") finish(`${msg.by} removed you from the party.`);
      else if (msg.type === "knock") knocked(msg.request);
      else if (msg.type === "knock-done") knockDone(msg.id);
      else if (msg.type === "talk") window.frunkTalk.play(msg.data);
      else if (msg.type === "talk-start") talkStarted(msg);
      else if (msg.type === "talk-end") talkEnded(msg);
    };
    // Closed for good (the server said no): rejoin, which also tells us if it ended.
    es.onerror = () => {
      if (es !== events || es.readyState !== EventSource.CLOSED) return;
      const code = session && session.code;
      events = null;
      if (code) join(code, { quiet: true }).then(() => { if (!session || !events) finish("The party has ended."); });
    };
  }

  // ---------- Waiting to be let in ----------
  let waitTimer = null;
  function waitFor(code, hostName) {
    const name = hostName || "the host";
    const text = $("partyWaitText");
    const again = $("partyWaitAgain");
    const settle = (message) => {
      clearTimeout(waitTimer);
      text.textContent = message;
      again.hidden = false;
    };
    $("partyWaitTitle").textContent = "Asking to join…";
    text.textContent = `Waiting for ${name} to let you in. This screen updates by itself.`;
    again.hidden = true;
    again.onclick = () => join(code, { hostName });
    if (!$("partyWait").open) $("partyWait").showModal();
    const poll = async () => {
      if (!$("partyWait").open) return;
      const { status } = await f.api(`/api/party/${code}/request`).catch(() => ({ status: "waiting" }));
      if (status === "waiting") return (waitTimer = setTimeout(poll, 2000));
      if (status === "allowed") {
        $("partyWait").close();
        return join(code, { hostName });
      }
      if (status === "denied") return settle(`${name} didn't let you in.`);
      if (status === "expired") return settle(`${name} didn't answer.`);
      again.hidden = true;
      clearTimeout(waitTimer);
      text.textContent = status === "removed" ? `${name} removed you from this party.` : "That party has ended.";
    };
    clearTimeout(waitTimer);
    waitTimer = setTimeout(poll, 2000);
  }
  $("partyWait").addEventListener("close", () => clearTimeout(waitTimer));

  // ---------- Letting people in (host) ----------
  // Requests queue up; each is answered once, from whichever screen.
  let knocks = [];
  function knocked(request) {
    if (knocks.some((k) => k.id === request.id)) return;
    knocks.push(request);
    chime();
    showKnock();
  }
  function knockDone(id) {
    const showing = knocks[0] && knocks[0].id === id && $("partyKnock").open;
    knocks = knocks.filter((k) => k.id !== id);
    if (showing) {
      $("partyKnock").close();
      showKnock();
    }
  }
  function showKnock() {
    const k = knocks[0];
    if (!k || $("partyKnock").open) return;
    $("partyKnockWho").replaceChildren(dot(k));
    $("partyKnockTitle").textContent = `${k.name} wants to join`;
    $("partyKnockNote").textContent = k.guest ? "They're joining as a guest, without a Frunk account." : "They have a Frunk account.";
    const answer = (allow) => async () => {
      knocks = knocks.filter((x) => x !== k);
      $("partyKnock").close();
      await f.api(`/api/party/${session.code}/answer`, { method: "POST", body: JSON.stringify({ member: session.member, request: k.id, allow }) }).catch((err) => f.toast(err.message, 4000));
      showKnock();
    };
    $("partyKnockAllow").onclick = answer(true);
    $("partyKnockDeny").onclick = answer(false);
    $("partyKnock").showModal();
  }

  // ---------- Joining without an account ----------
  // A party link or code opened signed out: a name, and in as a guest of that
  // one party (if the host allows guests, maybe after asking).
  async function guestFlow(code) {
    let info;
    try {
      info = await f.api(`/api/party/${encodeURIComponent(code)}/info`);
    } catch (err) {
      return f.toast(err.message, 5000);
    }
    const form = $("partyGuestForm");
    $("partyGuestTitle").textContent = `Join ${info.host}'s Watch Party`;
    const closed = info.guests === "no";
    $("partyGuestNote").textContent = closed
      ? "This party is only for people with a Frunk account. Sign in to join."
      : info.guests === "ask" ? `Pick a name. ${info.host} will be asked to let you in.` : "Pick a name for the others to see.";
    $("partyGuestName").hidden = closed;
    $("partyGuestJoin").hidden = closed;
    form.name.value = store.lget("frunk-guest-name") || "";
    $("partyGuestSignIn").onclick = () => {
      $("partyGuest").close();
      store.set("frunk-party-pending", info.code);
      f.openSignIn("", "Sign in to join the Watch Party.");
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      f.pressed($("partyGuestJoin"), async () => {
        const name = form.name.value.trim();
        const r = await f.api(`/api/party/${info.code}/guest`, { method: "POST", body: JSON.stringify({ name }) });
        store.lset("frunk-guest-name", name);
        guestName = name;
        $("partyGuest").close();
        if (r.waiting) waitFor(info.code, info.host);
        else await enter(r);
      });
    };
    $("partyGuest").showModal();
  }
  let guestName = null;

  // Back to the home screen as it was.
  function finish(message) {
    if (events) events.close();
    events = null;
    stopTalking();
    session = null;
    party = null;
    store.del("frunk-party");
    unload();
    closeChat();
    unread = 0;
    showUnread();
    $("partyNotice").hidden = true;
    $("partyChatList").replaceChildren();
    $("partyFloats").replaceChildren();
    view.hidden = true;
    document.body.classList.remove("in-party");
    for (const id of ["partyPicker", "partySettings", "partyInvite", "partyKnock", "partyMoreDialog"]) if ($(id).open) $(id).close();
    knocks = [];
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
    // Audio: the cover, title and author, where a video would be.
    const audio = !!state.media && state.media.kind === "audio";
    $("partyArt").hidden = !audio;
    view.classList.toggle("audio", audio);
    if (audio) {
      $("partyArtTitle").textContent = state.media.title;
      $("partyArtSub").textContent = state.media.subtitle || "";
      const img = $("partyArtImg");
      if (!state.media.art) img.hidden = true;
      else if (img.getAttribute("src") !== state.media.art) {
        img.hidden = true; // shown once it loads; a book without a cover just has its title
        img.src = state.media.art;
      }
    }
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
    renderTalk();
    if ($("partySettings").open) renderSettings(); // people come and go while it's open
  }

  // Controls hide after a few seconds of playback, and come back on a touch.
  let idleTimer = null;
  function wake() {
    view.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (party && party.state.playing && $("partyChat").hidden) view.classList.add("idle"); }, 4000);
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
  const here = () => Math.max(0, car.active
    ? (Number.isFinite(car.currentTime) ? car.currentTime : target())
    : video.readyState ? video.currentTime : target());
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
  // ---------- Push-to-talk ----------
  // Hold Talk (or Space) to speak to everyone in the party, one person at a
  // time, like a walkie-talkie (talk.js; relayed by the server). The Tesla turns
  // the mic off in fullscreen, so there Talk explains that instead; everyone
  // still hears. While someone else talks, the movie dips.
  const talk = window.frunkTalk;
  const talkBtn = $("partyTalk");
  let talkHeld = false; // finger (or Space) down
  let talkLive = false; // the floor is ours and chunks are going out
  let talkEnding = false;
  let talkQueue = [];
  let talkSending = false;
  let talkSeq = 0;
  const micOffHere = () => f.isTesla && f.inFullscreen;
  function talkBlocked() {
    if (!party.you.talk) {
      if (party.talk === "accounts") return "Talking in this party needs a Frunk account.";
      return "The host hasn't let you talk in this party.";
    }
    if (micOffHere()) return "Tesla turns the microphone off in fullscreen. You'll still hear everyone. Exit fullscreen to talk.";
    if (!talk.supported()) return "This browser can't use a microphone here.";
    return null;
  }
  function renderTalk() {
    if (!party || !session) return;
    const t = party.talking;
    const other = !!t && t.member !== session.member;
    talkBtn.hidden = party.talk === "nobody";
    talkBtn.classList.toggle("live", talkLive);
    talkBtn.classList.toggle("off", !!talkBlocked());
    talkBtn.classList.toggle("busy", other);
    $("partyTalkText").textContent = talkLive ? "Talking" : party.you.talk && micOffHere() ? "Mic off" : "Talk";
    const banner = $("partyTalking");
    banner.hidden = !t;
    if (t) banner.replaceChildren(dot(t), other ? `${t.name} is talking` : "You're talking");
    duck(other);
  }
  // The movie at a quarter volume while someone else talks; back up once their
  // last words have played.
  let ducked = false;
  let unduckTimer = null;
  function duck(on) {
    clearTimeout(unduckTimer);
    if (on && !ducked) setDuck(true);
    else if (!on && ducked) unduckTimer = setTimeout(() => setDuck(false), 600);
  }
  function setDuck(on) {
    ducked = on;
    video.volume = on ? 0.25 : 1;
    car.duck(on ? 0.25 : 1);
  }

  async function talkDown() {
    if (talkHeld || !party) return;
    wake();
    talk.unlock();
    const blocked = talkBlocked();
    if (blocked) return f.toast(blocked, 6000);
    const t = party.talking;
    if (t && t.member !== session.member) return f.toast(`${t.name} is talking`, 2500);
    talkHeld = true;
    talkBtn.classList.add("opening");
    const s = session;
    try {
      await talk.start(sendChunk);
    } catch (err) {
      talkHeld = false;
      talkBtn.classList.remove("opening");
      return f.toast(err.message, 6000);
    }
    talkBtn.classList.remove("opening");
    if (!talkHeld || session !== s) return talk.stop(); // let go while the mic was starting
    try {
      await postTalk(s, { action: "start" });
    } catch (err) {
      talkHeld = false;
      talk.stop();
      return f.toast(err.message, 3000);
    }
    talkSeq = 0;
    talkQueue = [];
    talkLive = true;
    renderTalk();
    if (!talkHeld) talkUp(); // let go while asking for the floor
  }
  function talkUp() {
    if (talkHeld) {
      talkHeld = false;
      talk.stop(); // sends the last bit
    }
    if (!talkLive || talkEnding) return;
    // Let the last bit arrive (the mic flushes within 100 ms), then let go of the floor.
    talkEnding = true;
    setTimeout(() => {
      talkLive = false;
      renderTalk();
      if (!talkSending) sendEnd();
    }, 150);
  }
  // One chunk at a time, in order; a slow connection drops the oldest rather
  // than falling ever further behind.
  function sendChunk(data) {
    if (!talkLive) return;
    talkQueue.push({ seq: ++talkSeq, data });
    if (talkQueue.length > 10) talkQueue.shift();
    pump();
  }
  async function pump() {
    if (talkSending) return;
    talkSending = true;
    const s = session;
    while (talkQueue.length && session === s) {
      const chunk = talkQueue.shift();
      await postTalk(s, { action: "audio", ...chunk }).catch(() => {});
    }
    talkSending = false;
    if (talkEnding && !talkLive) sendEnd();
  }
  const postTalk = (s, body) => f.api(`/api/party/${s.code}/talk`, { method: "POST", body: JSON.stringify({ member: s.member, ...body }) });
  function sendEnd() {
    if (!talkEnding) return;
    talkEnding = false;
    talkQueue = [];
    if (session) postTalk(session, { action: "end" }).catch(() => {});
  }
  function talkStarted(msg) {
    if (!party) return;
    party.talking = { member: msg.member, name: msg.name, color: msg.color };
    talk.reset();
    renderTalk();
  }
  function talkEnded(msg) {
    if (!party) return;
    if (party.talking && party.talking.member === msg.member) party.talking = null;
    // Ours, cut off while still holding: the 30-second limit (or the host changed who can talk).
    if (session && msg.member === session.member && talkLive && !talkEnding) {
      talkLive = false;
      talkHeld = false;
      talkQueue = [];
      talk.stop();
      f.toast("That's the limit for one go. Press Talk again to keep talking.", 4000);
    }
    renderTalk();
  }
  function stopTalking() {
    talkHeld = false;
    talkLive = false;
    talkEnding = false;
    talkQueue = [];
    talk.close();
    clearTimeout(unduckTimer);
    if (ducked) setDuck(false);
    $("partyTalking").hidden = true;
  }
  talkBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { talkBtn.setPointerCapture(e.pointerId); } catch {}
    talkDown();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) talkBtn.addEventListener(type, talkUp);
  talkBtn.addEventListener("contextmenu", (e) => e.preventDefault()); // a long press isn't a menu
  talkBtn.addEventListener("click", (e) => e.preventDefault());
  // Space, on a keyboard: not while typing, and not as a click on a focused button.
  const spaceTalks = (e) => e.code === "Space" && session && !view.hidden && !view.classList.contains("mini") &&
    !e.target.closest("input, textarea, select") && !document.querySelector("dialog[open]");
  document.addEventListener("keydown", (e) => {
    if (!spaceTalks(e)) return;
    e.preventDefault();
    if (!e.repeat) talkDown();
  });
  document.addEventListener("keyup", (e) => {
    if (e.code !== "Space" || (!talkHeld && !talkLive)) return;
    e.preventDefault();
    talkUp();
  });
  // Voices need the page to have been tapped once; any tap on the party will do.
  view.addEventListener("pointerdown", () => talk.unlock());

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
    if (car.active) return car.unlock();
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
    car.unload();
    video.hidden = false;
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
    // In the car a Plex video plays on the canvas player (car.js): the Tesla pauses
    // <video> while driving.
    if (media.car && f.isTesla) {
      video.hidden = true;
      return car.load(media.car);
    }
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
      // A dropped connection or a hiccup decoding: try to carry on, a few
      // times, before saying it couldn't play.
      let retries = 0;
      const player = hls;
      player.on(window.Hls.Events.ERROR, (_, d) => {
        if (!d.fatal || player !== hls) return;
        if (retries++ < 3 && d.type === window.Hls.ErrorTypes.NETWORK_ERROR) return player.startLoad();
        if (retries <= 3 && d.type === window.Hls.ErrorTypes.MEDIA_ERROR) return player.recoverMediaError();
        f.toast(`Couldn't play this (${d.details}). Try choosing it again.`, 6000);
      });
      player.on(window.Hls.Events.FRAG_LOADED, () => (retries = 0));
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      video.src = src;
    }
  }
  video.addEventListener("error", () => {
    if (loadedSrc && !hls) f.toast("Couldn't play this. Try choosing it again.", 6000);
  });

  // Twice a second: match the party's clock.
  function sync() {
    if (car.active) {
      if (party && party.state.media) car.sync(party.state.playing, target());
      return showTime();
    }
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
  const times = (at) => `${clock(at)}${Number.isFinite(duration()) ? ` / ${clock(duration())}` : ""}`;
  function showTime() {
    if (!party || !party.state.media || scrubbing) return;
    const at = target();
    const seek = $("partySeek");
    if (Number.isFinite(duration())) seek.max = duration();
    seek.value = at;
    $("partyTime").textContent = times(at);
  }

  // ---------- Chat and reactions ----------
  const REACTIONS = ["😂", "😮", "❤️", "👏", "🔥", "😢"]; // the server's list
  // The car's on-screen keyboard has no emoji, so here are the common ones.
  const EMOJI = ["😂", "❤️", "👍", "😮", "🔥", "👏", "😢", "🎉", "🙌", "😍", "🤔", "👀", "😴", "🍿"];
  const timeFmt = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });

  // These emoji are drawn from images (Twemoji, in /vendor/twemoji), so they
  // look right even where the browser has no emoji font. Others are left to the device.
  const emojiFile = (ch) => [...ch].map((c) => c.codePointAt(0).toString(16)).filter((h) => h !== "fe0f").join("-");
  function emojiImg(ch) {
    const img = document.createElement("img");
    img.className = "emoji";
    img.src = `/vendor/twemoji/${emojiFile(ch)}.svg`;
    img.alt = ch;
    img.draggable = false;
    return img;
  }
  const emojiRe = new RegExp(`(${[...new Set([...REACTIONS, ...EMOJI])].join("|")})`, "u");
  // Text with the known emoji as images; never HTML.
  function richText(el, text) {
    el.replaceChildren(...text.split(emojiRe).filter(Boolean).map((part) => (emojiRe.test(part) ? emojiImg(part) : document.createTextNode(part))));
    return el;
  }
  let unread = 0;

  async function say(body) {
    try {
      await f.api(`/api/party/${session.code}/chat`, { method: "POST", body: JSON.stringify({ member: session.member, ...body }) });
      return true;
    } catch (err) {
      f.toast(err.message, 4000);
      return false;
    }
  }

  function messageEl(m) {
    const el = document.createElement("div");
    el.className = "party-msg";
    const head = document.createElement("div");
    head.className = "party-msg-head";
    const when = document.createElement("time");
    when.textContent = timeFmt.format(new Date(m.at));
    head.append(dot(m), m.name);
    if (m.guest) head.append(Object.assign(document.createElement("span"), { className: "party-tag", textContent: "guest" }));
    head.append(when);
    el.append(head, richText(document.createElement("p"), m.text));
    return el;
  }
  function showHistory(messages) {
    $("partyChatList").replaceChildren(...messages.map(messageEl));
    scrollChat();
  }
  const scrollChat = () => { const list = $("partyChatList"); list.scrollTop = list.scrollHeight; };
  function addMessage(m) {
    const list = $("partyChatList");
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.append(messageEl(m));
    if (atBottom) scrollChat();
    // Sent from this screen; your other screens (phone and car) still count as others.
    const mine = session && m.from === session.member;
    if (mine || (!$("partyChat").hidden && !view.classList.contains("mini"))) return;
    unread++;
    showUnread();
    chime();
    if (view.classList.contains("mini")) notice(m);
    else bubble(m);
  }
  function showUnread() {
    for (const id of ["partyUnread", "partyMiniUnread"]) {
      $(id).hidden = !unread;
      $(id).textContent = unread > 9 ? "9+" : unread;
    }
    document.title = unread ? `(${unread}) Frunk` : "Frunk";
  }

  // On the home screen (party minimized): a banner at the top; tap for the chat.
  let noticeTimer = null;
  function notice(m) {
    const el = $("partyNotice");
    el.replaceChildren(dot(m), Object.assign(document.createElement("b"), { textContent: m.name }), richText(document.createElement("span"), m.text));
    el.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (el.hidden = true), 6000);
  }
  $("partyNotice").onclick = () => {
    $("partyNotice").hidden = true;
    show(true);
    openChat();
  };

  // A soft two-note chime for new messages and people asking to join, unless muted.
  let chimeCtx = null;
  let muted = store.lget("frunk-chat-muted") === true;
  function chime() {
    if (muted) return;
    try {
      chimeCtx ||= new AudioContext();
      const t = chimeCtx.currentTime;
      for (const [freq, at] of [[880, 0], [1320, 0.12]]) {
        const osc = chimeCtx.createOscillator();
        const gain = chimeCtx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + at);
        gain.gain.exponentialRampToValueAtTime(0.12, t + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.25);
        osc.connect(gain).connect(chimeCtx.destination);
        osc.start(t + at);
        osc.stop(t + at + 0.3);
      }
    } catch {}
  }
  function showMute() {
    $("partyMute").classList.toggle("off", muted);
    $("partyMute").setAttribute("aria-label", muted ? "Turn chat sound on" : "Turn chat sound off");
  }
  $("partyMute").onclick = () => {
    muted = !muted;
    store.lset("frunk-chat-muted", muted);
    showMute();
    if (!muted) chime();
  };
  showMute();

  // A message over the video while the chat is closed, gone after a few seconds.
  function bubble(m) {
    const el = document.createElement("div");
    el.className = "party-bubble";
    el.append(dot(m), richText(document.createElement("span"), m.text));
    el.onclick = openChat;
    const floats = $("partyFloats");
    floats.append(el);
    while (floats.querySelectorAll(".party-bubble").length > 3) floats.querySelector(".party-bubble").remove();
    setTimeout(() => el.classList.add("gone"), 5000);
    setTimeout(() => el.remove(), 5600);
  }

  // A reaction rises up the right side of everyone's screen.
  function floatReaction(r) {
    if (view.hidden || view.classList.contains("mini")) return;
    const el = document.createElement("div");
    el.className = "party-float";
    el.style.right = `${4 + Math.random() * 14}%`;
    const face = emojiImg(r.reaction);
    const who = document.createElement("small");
    who.textContent = r.name;
    el.append(face, who);
    $("partyFloats").append(el);
    setTimeout(() => el.remove(), 3200);
  }

  function openChat() {
    $("partyNotice").hidden = true;
    $("partyChat").hidden = false;
    view.classList.add("chatting");
    unread = 0;
    showUnread();
    scrollChat();
    wake();
  }
  function closeChat() {
    $("partyChat").hidden = true;
    view.classList.remove("chatting");
  }
  $("partyChatBtn").onclick = () => ($("partyChat").hidden ? openChat() : closeChat());
  // A phone held upright: video on top, then the controls, then chat, always open.
  const portraitPhone = matchMedia("(max-width: 640px) and (orientation: portrait)");
  const chatForLayout = () => { if (session) (portraitPhone.matches ? openChat() : closeChat()); };
  portraitPhone.addEventListener?.("change", chatForLayout);

  // ---------- The ⋯ menu (phones): the top bar's less-used buttons ----------
  $("partyMore").onclick = () => {
    $("partyMoreCode").textContent = party.code;
    $("partyMoreSettings").hidden = $("partySettingsBtn").hidden;
    $("partyMoreFullscreen").hidden = $("partyFullscreen").hidden;
    $("partyMoreLeave").textContent = $("partyLeave").textContent;
    $("partyMoreDialog").showModal();
  };
  for (const [item, target] of [["partyMoreInvite", "partyInviteBtn"], ["partyMoreSettings", "partySettingsBtn"], ["partyMoreFullscreen", "partyFullscreen"], ["partyMoreMinimize", "partyMinimize"], ["partyMoreLeave", "partyLeave"]]) {
    $(item).onclick = () => {
      $("partyMoreDialog").close();
      $(target).click();
    };
  }
  $("partyChatClose").onclick = closeChat;
  $("partyChatForm").onsubmit = async (e) => {
    e.preventDefault();
    const input = $("partyChatForm").text;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    if (!(await say({ text }))) input.value = text; // keep it to try again
  };
  // The car's keyboard covers the bottom of the screen without moving the page,
  // so while typing there, the chat moves into the top half (style.css).
  const input = $("partyChatForm").text;
  input.addEventListener("focus", () => {
    if (!f.isTesla) return;
    $("partyChat").classList.add("typing");
    scrollChat();
  });
  input.addEventListener("blur", () => $("partyChat").classList.remove("typing"));
  for (const emoji of EMOJI) {
    const b = document.createElement("button");
    b.type = "button";
    b.onpointerdown = (e) => e.preventDefault(); // keep the keyboard up while adding emoji
    b.append(emojiImg(emoji));
    b.setAttribute("aria-label", `Add ${emoji}`);
    b.onclick = () => {
      const input = $("partyChatForm").text;
      const at = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, at) + emoji + input.value.slice(input.selectionEnd ?? at);
      input.setSelectionRange(at + emoji.length, at + emoji.length);
    };
    $("partyEmoji").append(b);
  }
  for (const reaction of REACTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "party-react";
    b.append(emojiImg(reaction));
    b.setAttribute("aria-label", `React ${reaction}`);
    b.onclick = () => say({ reaction });
    $("partyReacts").append(b);
  }

  $("partyArtImg").onload = () => ($("partyArtImg").hidden = false);
  $("partyArtImg").onerror = () => ($("partyArtImg").hidden = true);

  // ---------- Choosing what plays ----------
  // only: an app's id, when opened from that app's tile.
  let pickSources = [];
  let pickSource = null;
  let pickSeq = 0;
  let pickPath = []; // folders opened, [{ id, title }]
  async function openPicker(only) {
    try {
      pickSources = await f.api(`/api/party/${session.code}/sources/${session.member}`);
    } catch (err) {
      return f.toast(err.message, 4000);
    }
    if (!pickSources.length) return f.toast("Nothing to play from yet.");
    pickSource = pickSources.find((x) => x.id === only) || (pickSource && pickSources.find((x) => x.id === pickSource.id)) || pickSources[0];
    $("partyPickForm").q.value = "";
    pickPath = [];
    renderTabs();
    $("partyPicker").showModal();
    loadPicks();
  }
  // One tab per app, shown as its logo (Plex, FSP, Audiobookshelf).
  function renderTabs() {
    $("partyTabs").hidden = pickSources.length < 2;
    $("partyTabs").replaceChildren(...pickSources.map((x) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pick-tab";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(x === pickSource));
      b.setAttribute("aria-label", x.name);
      b.title = x.name;
      if (x.icon) {
        const img = new Image();
        img.alt = "";
        img.src = x.icon;
        img.onerror = () => img.replaceWith(x.name);
        b.append(img);
      } else {
        b.classList.add("text");
        b.textContent = x.name;
      }
      b.onclick = () => {
        pickSource = x;
        $("partyPickForm").q.value = "";
        pickPath = [];
        renderTabs();
        loadPicks();
      };
      return b;
    }));
  }
  const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text != null ? { textContent: text } : {});
  // Placeholders the shape of what's coming, while it loads.
  function skeleton(folder) {
    const grid = el("div", `pick-grid ${folder ? "poster" : "wide"}`);
    for (let i = 0; i < (folder ? 12 : 4); i++) {
      const card = el("div", `pick-card ${folder ? "poster" : "wide"}`);
      card.append(el("div", "pick-art skel"), el("div", "pick-line skel"));
      grid.append(card);
    }
    return grid;
  }
  const LIBRARY_ICONS = {
    movie: '<path d="M4 5h16v14H4zM4 9h16M4 15h16M8 5v4M12 5v4M16 5v4M8 15v4M12 15v4M16 15v4"/>',
    show: '<path d="M3 6h18v12H3zM8 21h8M12 3l3 3M12 3L9 6"/>',
    artist: '<path d="M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/>',
  };
  // A card for something to play or open: its picture in the item's shape
  // (poster, wide still, square cover), how far you got, title and a line under.
  function pickCard(item, onPick) {
    const shape = ["poster", "wide", "square"].includes(item.shape) ? item.shape : "square";
    const b = el("button", `pick-card ${shape}${item.kind === "folder" ? " folder" : ""}`);
    b.type = "button";
    const art = el("div", "pick-art");
    art.append(el("span", "pick-letter", (item.title.trim()[0] || "?").toUpperCase()));
    if (item.art) {
      const img = new Image();
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.onload = () => img.classList.add("in");
      img.onerror = () => img.remove();
      img.src = `/api/party/${session.code}/art/${pickSource.id}/${encodeURIComponent(item.id)}?${new URLSearchParams({ shape, img: item.img || "thumb" })}`;
      art.append(img);
    }
    if (item.progress > 0.01) {
      const bar = el("div", "pick-progress");
      bar.append(Object.assign(el("i"), { style: `width:${Math.round(item.progress * 100)}%` }));
      art.append(bar);
    }
    if (item.kind === "audio" && shape !== "square") art.append(el("span", "pick-kind", "Audio"));
    const text = el("div", "pick-text");
    text.append(el("b", "", item.title), el("small", "", item.subtitle || (item.year ? String(item.year) : "")));
    b.append(art, text);
    b.onclick = () => onPick(item);
    return b;
  }
  function libraryChip(item, onPick) {
    const b = el("button", "pick-lib");
    b.type = "button";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = LIBRARY_ICONS[item.library] || LIBRARY_ICONS.movie;
    const text = el("span", "pick-lib-text");
    text.append(el("b", "", item.title), el("small", "", item.subtitle || ""));
    b.append(icon, text);
    b.onclick = () => onPick(item);
    return b;
  }
  // Items in groups (Continue watching, Libraries), the rest in a grid per shape.
  function renderPicks(items, onPick) {
    const out = [];
    const groups = new Map();
    const loose = new Map(); // shape -> items
    for (const item of items) {
      if (item.group) (groups.get(item.group) || groups.set(item.group, []).get(item.group)).push(item);
      else {
        const shape = ["poster", "wide", "square"].includes(item.shape) ? item.shape : "square";
        (loose.get(shape) || loose.set(shape, []).get(shape)).push(item);
      }
    }
    for (const [name, list] of groups) {
      out.push(el("h3", "pick-group", name));
      if (list.every((i) => i.shape === "library")) {
        const libs = el("div", "pick-libs");
        libs.append(...list.map((i) => libraryChip(i, onPick)));
        out.push(libs);
      } else {
        const row = el("div", "pick-row");
        row.append(...list.map((i) => pickCard(i, onPick)));
        out.push(row);
      }
    }
    for (const [shape, list] of loose) {
      const grid = el("div", `pick-grid ${shape}`);
      grid.append(...list.map((i) => pickCard(i, onPick)));
      out.push(grid);
    }
    return out;
  }
  async function loadPicks() {
    const seq = ++pickSeq;
    const box = $("partyPickList");
    const q = $("partyPickForm").q.value.trim();
    const folder = !q && pickPath.length ? pickPath[pickPath.length - 1] : null;
    $("partyPickBack").hidden = !folder;
    $("partyPickWhere").textContent = folder ? pickPath.map((p) => p.title).join(" › ") : "";
    box.replaceChildren(skeleton(!!folder || !!q));
    box.scrollTop = 0;
    let items;
    try {
      items = await f.api(`/api/party/${session.code}/browse/${session.member}?${new URLSearchParams({ source: pickSource.id, q, in: folder ? folder.id : "" })}`);
    } catch (err) {
      if (seq === pickSeq) box.replaceChildren(Object.assign(document.createElement("p"), { className: "hint error", textContent: err.message }));
      return;
    }
    if (seq !== pickSeq) return;
    if (!items.length) {
      box.replaceChildren(el("p", "hint", q ? `Nothing matches “${q}”.` : "Nothing here yet."));
      return;
    }
    // A show with just one season: straight to its episodes (Back skips it too).
    if (folder && !folder.auto && items.length === 1 && items[0].kind === "folder" && items[0].shape === "poster") {
      pickPath.push({ id: items[0].id, title: items[0].title, auto: true });
      return loadPicks();
    }
    box.replaceChildren(...renderPicks(items, (item) => {
      if (item.kind === "folder") {
        if (q) $("partyPickForm").q.value = "";
        pickPath.push({ id: item.id, title: item.title });
        return loadPicks();
      }
      $("partyPicker").close();
      f.toast(`Starting ${item.title}…`);
      control("load", { media: { source: pickSource.id, id: item.id } });
    }));
  }
  $("partyPickBack").onclick = () => {
    if (pickPath.pop()?.auto) pickPath.pop();
    loadPicks();
  };
  let searchTimer = null;
  $("partyPickForm").q.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadPicks, 350);
  };
  $("partyPickForm").onsubmit = (e) => {
    e.preventDefault();
    clearTimeout(searchTimer);
    loadPicks();
  };
  $("partyChoose").onclick = () => openPicker();
  $("partyEmptyChoose").onclick = () => openPicker();

  // ---------- Connected apps ----------
  // Your own key for each app the admin set up; hosting from it needs one.
  let appList = [];
  async function loadApps() {
    appList = await f.api("/api/apps").catch(() => []);
    $("appsBtn").hidden = !appList.length;
  }
  let linkTimer = null;
  // Plex and the like: a code to enter at the app's own site, then wait.
  async function startLink(app, box, button) {
    let r;
    try {
      r = await f.api(`/api/apps/${app.id}/link`, { method: "POST", body: "{}" });
    } catch (err) {
      return f.toast(err.message, 5000);
    }
    const code = document.createElement("div");
    code.className = "pair-code";
    code.textContent = r.code;
    const how = document.createElement("p");
    how.className = "hint";
    how.append("On your phone or computer, go to ", Object.assign(document.createElement("b"), { textContent: app.linkAt }), " and enter this code. This screen updates by itself.");
    button.replaceWith(code, how);
    const poll = async () => {
      if (!$("appsDialog").open) return;
      const s = await f.api(`/api/apps/${app.id}/link`).catch(() => ({ status: "waiting" }));
      if (s.status === "waiting") return (linkTimer = setTimeout(poll, 2000));
      if (s.status === "connected") f.toast(`${app.name} connected`);
      else f.toast(s.error || "That code expired. Try again.", 5000);
      appsChanged();
    };
    clearTimeout(linkTimer);
    linkTimer = setTimeout(poll, 2000);
  }
  function renderApps() {
    $("appsList").replaceChildren(...appList.map((app) => {
      const box = document.createElement("div");
      box.className = "app-row";
      const name = document.createElement("div");
      name.className = "app-name";
      name.textContent = app.name;
      const note = document.createElement("p");
      note.className = "hint";
      box.append(name, note);
      if (app.connected) {
        note.textContent = `Connected as ${app.account} on ${app.host}.`;
        const off = document.createElement("button");
        off.type = "button";
        off.className = "pill small danger";
        off.textContent = "Disconnect";
        off.onclick = () => f.pressed(off, async () => {
          await f.api(`/api/apps/${app.id}`, { method: "DELETE" });
          await appsChanged();
        });
        box.append(off);
      } else if (app.connect === "link") {
        note.textContent = `Sign in with your ${app.name} account. You'll get a code to enter on ${app.name}'s site.`;
        const go = document.createElement("button");
        go.type = "button";
        go.className = "pill accent";
        go.textContent = `Connect ${app.name}`;
        go.onclick = () => f.pressed(go, () => startLink(app, box, go));
        box.append(go);
      } else {
        note.textContent = app.help || "Paste your key from the app.";
        const row = document.createElement("div");
        row.className = "invite-row";
        const input = document.createElement("input");
        input.type = "password";
        input.placeholder = "API key";
        input.autocomplete = "off";
        input.spellcheck = false;
        const go = document.createElement("button");
        go.type = "button";
        go.className = "pill accent";
        go.textContent = "Connect";
        go.onclick = () => f.pressed(go, async () => {
          await f.api(`/api/apps/${app.id}`, { method: "PUT", body: JSON.stringify({ token: input.value }) });
          f.toast(`${app.name} connected`);
          await appsChanged();
        });
        row.append(input, go);
        box.append(row);
      }
      return box;
    }));
  }
  async function appsChanged() {
    await loadApps();
    sources = await f.api("/api/party/sources").catch(() => sources);
    renderApps();
    renderBar();
  }
  $("appsBtn").onclick = async () => {
    $("accountDialog").close();
    renderApps();
    $("appsDialog").showModal();
  };

  // ---------- Party settings (host) ----------
  // Who can join and control; with Co-pilots, the people to pick right under it.
  // Then the people here, to remove.
  function renderSettings() {
    renderChoices($("partySettingsChoices"), { ...party.access, mode: party.mode, talk: party.talk }, (key, value) =>
      saveSettings(key === "mode" || key === "talk" ? { [key]: value } : { access: { [key]: value } }), {
      mode: () => (party.mode === "copilots" ? [copilotPicker()] : []),
    });
    const others = party.people.filter((p) => !p.host);
    $("partyPeopleList").replaceChildren(...(others.length ? others.map((p) => {
      const row = document.createElement("div");
      row.className = "party-person";
      const name = document.createElement("span");
      name.className = "party-person-name";
      name.append(dot(p), p.name);
      if (p.guest) name.append(Object.assign(document.createElement("span"), { className: "party-tag", textContent: "guest" }));
      else if (party.mode === "copilots" && p.copilot) name.append(Object.assign(document.createElement("span"), { className: "party-tag", textContent: "co-pilot" }));
      row.append(name);
      const out = document.createElement("button");
      out.type = "button";
      out.className = "pill small danger";
      out.textContent = "Remove";
      out.onclick = () => ask(`Remove ${p.name}?`, "They leave the party and can't come back to it.", "Remove", async () => {
        await f.api(`/api/party/${session.code}/remove`, { method: "POST", body: JSON.stringify({ member: session.member, person: p.id }) }).catch((err) => f.toast(err.message, 4000));
      });
      row.append(out);
      return row;
    }) : [Object.assign(document.createElement("p"), { className: "hint", textContent: "Nobody else has joined yet." })]));
  }
  // Everyone here as a big toggle; guests shown but greyed (co-pilots need an account).
  function copilotPicker() {
    const others = party.people.filter((p) => !p.host);
    const eligible = others.filter((p) => !p.guest);
    const box = document.createElement("div");
    box.className = "send-people copilot-pick";
    if (!eligible.length) {
      box.append(hintEl("Co-pilots are picked from people here with a Frunk account. Nobody like that has joined yet."));
    }
    for (const p of others) {
      box.append(f.personToggle({
        name: [dot(p), p.name], hint: p.guest ? "Guest · needs a Frunk account" : "", pressed: !!p.copilot, disabled: p.guest,
        onClick: () => saveSettings({ copilots: eligible.filter((g) => (g === p ? !g.copilot : g.copilot)).map((g) => g.id) }),
      }));
    }
    return box;
  }
  async function saveSettings(body) {
    try {
      await f.api(`/api/party/${session.code}/settings`, { method: "POST", body: JSON.stringify({ member: session.member, ...body }) });
    } catch (err) {
      f.toast(err.message, 4000);
    }
  }
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
    if (me) join(code);
    else guestFlow(code);
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
        // Signed out: a party link or /join means joining as a guest; a reload
        // or the fullscreen trip rejoins with the guest pass this browser has.
        const code = f.params.get("party");
        const saved = store.get("frunk-party");
        guestName = store.lget("frunk-guest-name");
        if (location.pathname === "/join") {
          history.replaceState(null, "", "/");
          $("partyCodeForm").reset();
          $("partyCodeDialog").showModal();
        } else if (code) {
          history.replaceState(null, "", "/");
          guestFlow(code);
        } else if (saved) {
          join(saved.code, { quiet: true });
        }
        return;
      }
      sources = await f.api("/api/party/sources").catch(() => []);
      loadApps();
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
        join(code);
      } else if (hosting) {
        host();
      } else if (saved) {
        join(saved.code, { quiet: true }); // after a reload or the fullscreen trip
      }
    },
  };
})();
