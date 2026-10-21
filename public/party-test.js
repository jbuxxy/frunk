// Frunk — Watch Party car test (/party/test)
(() => {
  const $ = (id) => document.getElementById(id);
  // Same check as the launcher (app.js): the Tesla browser reports plain Linux
  // Chrome, but with a touchscreen.
  const isTesla = (() => {
    const ua = navigator.userAgent;
    if (/\bTesla\b/i.test(ua)) return true;
    return /X11; Linux/.test(ua) && !/Android|CrOS/.test(ua) && navigator.maxTouchPoints > 0;
  })();
  const STREAM = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
  const started = Date.now();
  const results = {}; // test section id -> { state, ...details }
  const timeline = []; // what happened when: tab hidden/shown, call and video changes

  const store = {
    sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    sset(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  };
  const secs = () => Math.round((Date.now() - started) / 1000);
  const note = (event) => { timeline.push(`${secs()}s ${event}`); if (timeline.length > 200) timeline.shift(); };

  function setStatus(test, state, info) {
    $(test).querySelector("[data-status]").dataset.state = state;
    results[test] = { ...results[test], ...info, state };
  }
  const stateOf = (test) => results[test] && results[test].state;

  async function api(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------- Fullscreen (the launcher's YouTube redirect, back to this page) ----------
  if (new URLSearchParams(location.search).get("fs") === "1") {
    store.sset("frunk-fs", "1");
    history.replaceState(null, "", "/party/test");
  }
  const inFullscreen = store.sget("frunk-fs") === "1";
  $("fsBtn").hidden = !isTesla || inFullscreen;
  $("fsBtn").onclick = () => location.assign(`https://www.youtube.com/redirect?q=${encodeURIComponent(`${location.origin}/party/test?fs=1`)}`);

  $("testHost").textContent = `${location.host}/party/test`;
  let me = null;
  fetch("/api/me").then((r) => r.json()).then((body) => {
    me = body.user;
    if (!me) {
      $("signedOut").hidden = false;
      for (const id of ["startBtn", "joinBtn", "sendBtn"]) $(id).disabled = true;
    }
  }).catch(() => {});

  let audioCtx = null;
  function audio() {
    audioCtx ||= new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  // ---------- 1. Microphone ----------
  let mic = null;
  let micLevel = 0;
  function micError(err) {
    if (err.name === "NotAllowedError") return "The microphone was blocked. Allow it in the car's prompt or the site's permissions, then reload.";
    if (err.name === "NotFoundError") return "No microphone was found.";
    return `${err.name}: ${err.message}`;
  }
  async function startMic() {
    if (mic) return true;
    setStatus("t-mic", "running");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const why = window.isSecureContext ? "This browser doesn't let websites use the microphone." : "The microphone needs Frunk on HTTPS.";
      $("micDetail").textContent = why;
      setStatus("t-mic", "fail", { error: why });
      return false;
    }
    // A refusal within a moment, with no prompt shown, means the browser
    // decided by itself; the permission state says whether a "deny" was saved.
    const permission = await navigator.permissions?.query({ name: "microphone" }).then((p) => p.state, () => "unknown") ?? "unknown";
    const asked = Date.now();
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      const ms = Date.now() - asked;
      $("micDetail").textContent = `${micError(err)} (permission: ${permission}, answered in ${ms} ms${inFullscreen ? ", in fullscreen" : ""})`;
      setStatus("t-mic", "fail", { error: err.name, message: err.message, permission, ms, fullscreen: inFullscreen });
      return false;
    }
    const track = mic.getAudioTracks()[0];
    const s = track.getSettings ? track.getSettings() : {};
    $("micDetail").textContent = `${track.label || "Microphone"} · echo cancellation ${s.echoCancellation ? "on" : "off"}`;
    results["t-mic"] = { ...results["t-mic"], label: track.label, echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression };
    track.onended = () => note("microphone stopped");
    $("micBtn").disabled = true;
    $("micBtn").textContent = "Microphone on";

    const analyser = audio().createAnalyser();
    analyser.fftSize = 512;
    audio().createMediaStreamSource(mic).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let loud = 0;
    setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((sum, x) => sum + x * x, 0) / buf.length);
      micLevel = Math.min(1, rms * 8);
      $("micLevel").style.width = `${micLevel * 100}%`;
      if (micLevel > 0.15 && ++loud === 3 && stateOf("t-mic") !== "pass") setStatus("t-mic", "pass");
      showSpeaking();
    }, 100);
    return true;
  }
  $("micBtn").onclick = startMic;

  // ---------- 2. Voice call ----------
  // The device that joins second sends the offer. Handshake messages go
  // through the Frunk server; audio goes device to device or via TURN.
  let room = null; // { code, id, iceServers }
  let remote = null; // { id, name, color }
  let pc = null;
  let pending = []; // ICE candidates that arrived before the offer/answer
  let signals = Promise.resolve(); // handled one at a time, in order
  let remoteLevel = 0;
  let heardRemote = 0;
  let stats = { route: "", rtt: null, packetsSent: 0, bytesReceived: 0 };
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;

  function initial(name) { return (String(name || "?").trim()[0] || "?").toUpperCase(); }
  function renderPeople() {
    const people = [{ key: "me", name: me ? `${me.name} (you)` : "You", color: me && me.avatarColor }];
    if (remote) people.push({ key: "remote", name: remote.name, color: remote.color });
    $("people").replaceChildren(...people.map((p) => {
      const el = document.createElement("div");
      el.className = "person";
      el.dataset.who = p.key;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = p.color || "var(--accent)";
      dot.textContent = initial(p.name);
      el.append(dot, p.name);
      return el;
    }));
  }
  function showSpeaking() {
    const mine = document.querySelector('.person[data-who="me"]');
    const theirs = document.querySelector('.person[data-who="remote"]');
    if (mine) mine.classList.toggle("speaking", micLevel > 0.12);
    if (theirs) theirs.classList.toggle("speaking", remoteLevel > 0.04);
  }

  function signal(data) {
    if (!room || !remote) return;
    api("/api/party-test/signal", { code: room.code, from: room.id, to: remote.id, data }).catch((err) => note(`signal failed: ${err.message}`));
  }

  function showCall() {
    const state = pc ? pc.connectionState : "waiting";
    const parts = [remote ? `Call ${state}` : "Waiting for the other device…"];
    if (stats.route) parts.push(stats.route);
    if (stats.rtt != null) parts.push(`${Math.round(stats.rtt * 1000)} ms round trip`);
    if (state === "failed") parts.push(room.iceServers.length > 1 ? "couldn't get through, even via TURN" : "couldn't get through; a TURN relay is probably needed (FRUNK_TURN_URLS)");
    $("callDetail").textContent = parts.join(" · ");
  }

  function connect(initiator) {
    if (pc) pc.close();
    pending = [];
    pc = new RTCPeerConnection({ iceServers: room.iceServers });
    for (const track of mic.getTracks()) pc.addTrack(track, mic);
    pc.onicecandidate = (e) => { if (e.candidate) signal({ candidate: e.candidate }); };
    pc.ontrack = (e) => {
      remoteAudio.srcObject = e.streams[0];
      remoteAudio.play().catch(() => {});
    };
    const self = pc;
    pc.onconnectionstatechange = () => {
      if (pc !== self) return;
      note(`call ${pc.connectionState}`);
      if (pc.connectionState === "failed") setStatus("t-call", "fail", { error: "couldn't connect", route: stats.route });
      showCall();
    };
    if (initiator) {
      pc.createOffer()
        .then((offer) => self.setLocalDescription(offer))
        .then(() => signal({ sdp: self.localDescription }))
        .catch((err) => note(`offer failed: ${err.message}`));
    }
    showCall();
  }

  async function onSignal(data) {
    if (!pc) connect(false);
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === "offer") {
        await pc.setLocalDescription(await pc.createAnswer());
        signal({ sdp: pc.localDescription });
      }
      for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else pending.push(data.candidate);
    }
  }

  function onEvent(msg) {
    if (msg.type === "peer-joined") {
      remote = msg.peer;
      note(`${remote.name} joined`);
      renderPeople();
      connect(false);
    } else if (msg.type === "peer-left") {
      note("the other device left");
      if (pc) pc.close();
      pc = null;
      remote = null;
      remoteLevel = 0;
      renderPeople();
      showCall();
    } else if (msg.type === "signal" && remote && msg.from === remote.id) {
      signals = signals.then(() => onSignal(msg.data)).catch((err) => note(`handshake failed: ${err.message}`));
    }
  }

  async function enterCall(code) {
    if (!(await startMic())) return;
    let joined;
    try {
      joined = await api("/api/party-test/join", { code });
    } catch (err) {
      $("callDetail").textContent = err.message;
      return;
    }
    room = joined;
    setStatus("t-call", "running", { code: room.code, turn: room.iceServers.length > 1 });
    $("callSetup").hidden = true;
    $("callLive").hidden = false;
    $("roomCode").textContent = room.code;
    remote = joined.peers[0] || null;
    renderPeople();
    const events = new EventSource(`/api/party-test/events/${room.code}/${room.id}`);
    events.onmessage = (e) => onEvent(JSON.parse(e.data));
    events.onopen = () => note("server link open");
    events.onerror = () => note("server link dropped");
    if (remote) connect(true);
    else showCall();
  }
  $("startBtn").onclick = () => enterCall("");
  $("joinBtn").onclick = () => {
    const code = $("codeInput").value.trim().toUpperCase();
    if (code.length === 4) enterCall(code);
    else $("callDetail").textContent = "Enter the 4-letter code shown on the other device.";
  };
  $("codeInput").onkeydown = (e) => { if (e.key === "Enter") $("joinBtn").click(); };

  async function readStats() {
    if (!pc) return;
    const report = await pc.getStats();
    let pairId = null;
    report.forEach((r) => {
      if (r.type === "inbound-rtp" && r.kind === "audio") {
        remoteLevel = r.audioLevel || 0;
        stats.bytesReceived = r.bytesReceived || 0;
      } else if (r.type === "outbound-rtp" && r.kind === "audio") {
        stats.packetsSent = r.packetsSent || 0;
      } else if (r.type === "transport" && r.selectedCandidatePairId) {
        pairId = r.selectedCandidatePairId;
      }
    });
    if (!pairId) report.forEach((r) => { if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pairId = r.id; });
    const pair = pairId && report.get(pairId);
    if (pair) {
      const types = [report.get(pair.localCandidateId), report.get(pair.remoteCandidateId)].map((c) => c && c.candidateType);
      stats.route = types.includes("relay") ? "through the TURN relay" : types.every((t) => t === "host") ? "on the same network" : "direct between devices";
      stats.rtt = pair.currentRoundTripTime ?? null;
    }
    if (pc.connectionState === "connected" && remoteLevel > 0.04 && ++heardRemote === 4 && stateOf("t-call") !== "pass") {
      setStatus("t-call", "pass", { route: stats.route, rttMs: stats.rtt != null ? Math.round(stats.rtt * 1000) : null });
    }
    showSpeaking();
    showCall();
  }
  setInterval(() => readStats().catch(() => {}), 250);

  // ---------- 3. Video ----------
  const video = $("video");
  let videoHow = "";
  let watched = 0;
  let lastTime = 0;
  let stalls = 0;
  function showVideo() {
    const size = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "";
    $("videoDetail").textContent = [videoHow, size, `${Math.floor(watched)}s played`, `${stalls} stall${stalls === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  }
  $("videoBtn").onclick = () => {
    $("videoBtn").disabled = true;
    video.hidden = false;
    setStatus("t-video", "running");
    const native = !!video.canPlayType("application/vnd.apple.mpegurl");
    const mse = !!(window.Hls && window.Hls.isSupported());
    results["t-video"] = { ...results["t-video"], nativeHls: native, mediaSource: mse };
    if (mse) {
      videoHow = "hls.js";
      const hls = new window.Hls({ enableWorker: false });
      hls.on(window.Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        $("videoDetail").textContent = `Playback failed: ${d.details}`;
        setStatus("t-video", "fail", { error: d.details });
      });
      hls.loadSource(STREAM);
      hls.attachMedia(video);
    } else if (native) {
      videoHow = "built-in HLS";
      video.src = STREAM;
    } else {
      $("videoDetail").textContent = "This browser can't play HLS video.";
      return setStatus("t-video", "fail", { error: "no HLS support" });
    }
    video.play().catch(() => ($("videoDetail").textContent = "Tap play on the video."));
  };
  video.onplaying = () => note("video playing");
  video.onpause = () => note("video paused");
  video.onwaiting = () => { if (watched > 0) { stalls++; note("video buffering"); } };
  video.onerror = () => setStatus("t-video", "fail", { error: video.error && video.error.message });
  video.ontimeupdate = () => {
    const step = video.currentTime - lastTime;
    lastTime = video.currentTime;
    if (step > 0 && step < 1.5) watched += step;
    if (watched >= 20 && stateOf("t-video") === "running") {
      setStatus("t-video", stalls <= 2 ? "pass" : "fail", { how: videoHow, size: `${video.videoWidth}x${video.videoHeight}`, stalls });
    }
    showVideo();
  };

  // ---------- 4. Rear screen while driving: a live readout ----------
  let hiddenCount = 0;
  const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  setInterval(() => {
    $("driveDetail").textContent = [
      `Page running ${clock(secs())} · video ${video.src && !video.paused ? "playing" : "stopped"} · call ${pc ? pc.connectionState : "off"} · hidden ${hiddenCount}×`,
      ...timeline.slice(-4),
    ].join("\n");
  }, 1000);

  // ---------- 4–6. Pass / fail buttons ----------
  for (const row of document.querySelectorAll("[data-verdict]")) {
    const test = row.dataset.verdict;
    for (const btn of row.querySelectorAll("button")) {
      btn.onclick = () => {
        for (const b of row.querySelectorAll("button")) b.classList.toggle("chosen", b === btn);
        setStatus(test, btn.hasAttribute("data-pass") ? "pass" : "fail");
      };
    }
  }

  // ---------- 6. Voice from another tab ----------
  // Timers slow down in a hidden tab, so the call's counters are compared on
  // the way out and on the way back: did the mic keep sending, did their
  // voice keep arriving?
  let away = null;
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) {
      hiddenCount++;
      note("page hidden");
      await readStats().catch(() => {});
      away = { at: Date.now(), sent: stats.packetsSent, received: stats.bytesReceived, call: !!pc };
      return;
    }
    note("page shown");
    if (!away) return;
    const was = away;
    away = null;
    await readStats().catch(() => {});
    const seconds = (Date.now() - was.at) / 1000;
    if (!was.call || !pc || seconds < 5) return;
    const sendRate = Math.round((stats.packetsSent - was.sent) / seconds); // ~50/s while the mic is live
    const receiveRate = Math.round((stats.bytesReceived - was.received) / seconds);
    const info = { awaySec: Math.round(seconds), micPacketsPerSec: sendRate, receivedBytesPerSec: receiveRate, call: pc.connectionState, audio: audioCtx && audioCtx.state };
    results["t-tab"] = { ...results["t-tab"], ...info };
    $("tabDetail").textContent = `Away ${Math.round(seconds)}s · your mic ${sendRate > 30 ? "kept sending" : sendRate > 0 ? "sent only part of the time" : "stopped"} · their voice ${receiveRate > 1000 ? "kept arriving" : "stopped arriving"} · call ${pc.connectionState}`;
  });
  $("tabBtn").onclick = () => {
    if (!pc) $("tabDetail").textContent = "Start the test call first (test 2), so there's a call to keep running.";
    const tab = window.open("https://www.disneyplus.com", "_blank");
    if (!tab) {
      $("tabDetail").textContent = "The browser didn't open a new tab.";
      setStatus("t-tab", "fail", { error: "no new tab" });
    }
  };

  // ---------- Send results ----------
  $("sendBtn").onclick = async () => {
    const report = {
      ua: navigator.userAgent,
      tesla: isTesla,
      fullscreen: inFullscreen,
      screen: `${screen.width}x${screen.height}`,
      results,
      timeline: timeline.slice(-40),
    };
    try {
      await api("/api/party-test/report", report);
      $("sendDetail").textContent = `Sent at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Send again any time to update.`;
    } catch (err) {
      $("sendDetail").textContent = `Couldn't send: ${err.message}`;
    }
  };
})();
