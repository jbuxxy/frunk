// Frunk — the car player for Watch Party. The Tesla pauses any <video> while
// driving, so in the car a Plex party plays here instead: FSP turns the title
// into H.264 (on its iGPU) or MPEG-1 video with MP2 audio in one stream, which JSMpeg
// decodes onto a <canvas> and Web Audio, keeping the two in step itself. H.264 is
// decoded by h264.js (the car's hardware decoder if its browser has one, else
// WebAssembly); a car that can't keep up is offered a lower quality (never switched by itself). Every car in a party
// shares that one stream; the server says where in the title this car joined
// (x-stream-pos), and JSMpeg's clock counts on from there.
window.frunkCar = (() => {
  const f = window.frunk;
  const box = document.getElementById("partyCar");

  let jsmpegReady = null;
  const loadScript = (src) => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${src}?v=${f.assetV}`;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  function loadJsmpeg() {
    jsmpegReady ||= loadScript("/vendor/jsmpeg.min.js").then(() => loadScript("/h264.js")).catch(() => {
      jsmpegReady = null;
      throw new Error("Couldn't load the car player. Try again.");
    });
    return jsmpegReady;
  }

  // What this car plays: H.264 at 720p on newer cars (AMD), 480p on older or unknown
  // ones, from its model (H264.choose); it doesn't step down by itself.
  const keep = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  // Once: forget step downs saved before October 2026's fix (pictures waiting for the
  // sound were taken for a car falling behind, which stepped cars down to MPEG-1).
  if (keep.get("frunk-car-reset") !== "2") { // 2: also a patchy connection's bursts
    try { localStorage.removeItem("frunk-car-codec"); localStorage.removeItem("frunk-car-q"); } catch {}
    keep.set("frunk-car-reset", "2");
  }
  let codec = "mpeg1";
  let quality = 720;
  let backend = null;
  // A quiet note for the Car check page in FSP (the owner's): how this car plays,
  // after the first minute of each title (every 20 minutes at most) and if it falls behind.
  let noteStart = 0; // this stream's first picture
  let noted = false;
  let behindNoted = false; // this stream's "fell behind" note sent
  function carNote(why) {
    if (!base || !info || !window.H264) return;
    // After the first minute of each party title, at most every 20 minutes.
    if (why === "first minute" && Date.now() - (Number(keep.get("frunk-carnote")) || 0) < 20 * 60_000) return;
    const note = window.H264.carNote(why, { codec, backend, q: quality, fps: info.fps, frames, since: noteStart, player });
    f.api(`${base}/note`, { method: "POST", body: JSON.stringify(note), keepalive: true }).catch(() => {});
    if (why === "first minute") keep.set("frunk-carnote", String(Date.now()));
  }


  let base = null; // /api/party/<code>/car/<load>
  let info = null; // { duration (ms), fps }
  let player = null;
  let canvas = null;
  let joinPos = 0; // where in the title this stream joined
  let frames = 0;
  let openedAt = 0;
  let lastFrame = 0;
  let retryAt = 0; // after a failed start, wait before trying again
  let sharedQ = null; // the quality of this stretch's shared stream, once joined (see open)
  let rejoinedAt = 0; // when this car last rejoined the shared stream to catch up
  let streamAt; // the party's state.at this stream belongs to (see sync)
  let ready = false; // load() has picked the codec and quality; no stream before that

  // A quiet hint when this car can't keep up: never switches by itself, one tap to the
  // next quality down. Slow connection: sound running dry 3 times in 2 minutes (after a
  // stream's first minute); gone after 3 minutes without. Behind: gone after 2 minutes
  // keeping up. Closed: not again for this title.
  const HINTS = { slow: "Slow connection", behind: "Struggling to keep up" };
  let hintEl = null, hintWhy = null, hintClosed = false, gapTimes = [], gapsSeen = 0, behindAt = 0;
  function hint(why) {
    const to = (sharedQ || quality) > 480 ? 480 : (sharedQ || quality) > 360 ? 360 : 0;
    if (!to || hintEl || hintClosed) return;
    hintWhy = why;
    hintEl = document.createElement("div");
    hintEl.className = "car-hint";
    hintEl.setAttribute("role", "status");
    const go = document.createElement("button");
    go.className = "go";
    go.append(`${HINTS[why]} · `, Object.assign(document.createElement("b"), { textContent: `Try ${to}p` }));
    go.onclick = (e) => {
      e.stopPropagation();
      hideHint();
      quality = to;
      sharedQ = null;
      if (player) { stop(true); open(false); }
    };
    const x = Object.assign(document.createElement("button"), { className: "x", textContent: "×" });
    x.setAttribute("aria-label", "Dismiss");
    x.onclick = (e) => { e.stopPropagation(); hintClosed = true; hideHint(); };
    hintEl.append(go, x);
    box.append(hintEl);
    requestAnimationFrame(() => hintEl && hintEl.classList.add("on"));
  }
  function hideHint() { if (hintEl) hintEl.remove(); hintEl = null; hintWhy = null; }
  function watchGaps(now) {
    const gaps = (player && player.audioOut && player.audioOut.gaps) || 0;
    if (gaps < gapsSeen) gapsSeen = 0; // a new player
    // Not in a stream's first minute: a reconnect (FSP restarting) settles with a gap or
    // two, and a lower quality wouldn't help that.
    if (!noteStart || now - noteStart < 60_000) gapsSeen = gaps;
    for (; gapsSeen < gaps; gapsSeen++) gapTimes.push(now);
    gapTimes = gapTimes.filter((t) => now - t < 180_000);
    if (gapTimes.filter((t) => now - t < 120_000).length >= 3) hint("slow");
    else if (!gapTimes.length && hintWhy === "slow") hideHint();
    if (hintWhy === "behind" && now - behindAt > 120_000) hideHint(); // kept up for 2 minutes
  }

  function stop(keepPicture) {
    if (player) {
      // A destroyed player blanks its canvas, so keep the last picture as a still.
      if (keepPicture && canvas && frames) {
        const still = window.H264.snapshot(player, canvas);
        if (still) box.style.backgroundImage = `url(${still})`;
      }
      try { player.destroy(); } catch {}
      player = null;
    }
    if (canvas) canvas.remove();
    canvas = null;
    frames = 0;
    gapsSeen = 0;
  }

  // solo: this car fell out of step, so it gets its own catch-up stream instead of
  // rejoining the shared one (which would put it right back where it was).
  async function open(solo) {
    openedAt = Date.now();
    try {
      await loadJsmpeg();
    } catch (err) {
      retryAt = Date.now() + 10_000;
      return f.toast(err.message, 5000);
    }
    if (!base || player) return;
    canvas = document.createElement("canvas");
    canvas.style.opacity = "0";
    box.append(canvas);
    joinPos = 0;
    frames = 0;
    noteStart = 0;
    behindNoted = false;
    const me = canvas;
    const url = `${base}/stream?codec=${codec}&q=${sharedQ || quality}${solo ? `&solo=${Math.random().toString(36).slice(2, 10)}` : ""}`;
    const Source = window.H264.fetchSource(
      (headers) => {
        joinPos = parseFloat(headers.get("x-stream-pos")) || 0;
        // The quality FSP gave this car (a 720p car shares a 480p stretch); ask for that
        // again when reconnecting, so a reconnect (FSP restarting) can't start a second encode.
        sharedQ = Number(headers.get("x-stream-q")) || null;
      },
      (err) => {
        if (canvas !== me) return;
        stop(true);
        retryAt = Date.now() + 10_000;
        f.toast(err.message, 5000);
      },
    );
    const options = {
      source: Source, canvas, audio: true, video: true,
      pauseWhenHidden: false, preserveDrawingBuffer: false,
      videoBufferSize: 4 * 1024 * 1024, audioBufferSize: 512 * 1024,
      fps: (info && info.fps) || 30, backend,
      onBehind: () => {
        if (canvas !== me) return;
        if (!behindNoted) { behindNoted = true; carNote("fell behind"); } // a note, once per stream
        behindAt = Date.now();
        hint("behind");
      },
      onVideoDecode: () => {
        if (canvas !== me) return;
        frames++;
        lastFrame = Date.now();
        noteStart ||= lastFrame;
        if (!noted && lastFrame - noteStart > 60_000) {
          noted = true;
          carNote("first minute");
        }
        if (frames === 1) {
          me.style.opacity = "1";
          box.style.backgroundImage = "";
        }
      },
    };
    player = codec === "h264" ? window.H264.createPlayer(url, options) : new window.JSMpeg.Player(url, window.H264.soundOptions(options));
    if (car.level !== 1) player.volume = car.level; // someone's talking
    // Sound needs a tap when the browser hasn't let this page play any yet.
    setTimeout(() => {
      const ctx = player && player.audioOut && player.audioOut.context;
      if (ctx && ctx.state === "suspended") car.onBlocked();
    }, 1500);
  }

  const car = {
    active: false,
    onBlocked() {},
    async load(url) {
      car.unload();
      base = url;
      const mine = url;
      car.active = true;
      box.hidden = false;
      try {
        info = await f.api(`${url}/info`);
      } catch (err) {
        f.toast(err.message, 5000);
      }
      // What this car plays (H264.choose, shared with FSP's player).
      codec = "mpeg1";
      try {
        await loadJsmpeg();
        ({ codec, q: quality, backend } = await window.H264.choose(info && info.codecs, {}));
      } catch {}
      if (base === mine) ready = true;
    },
    unload() {
      ready = false;
      stop(false);
      hideHint();
      hintClosed = false;
      gapTimes = [];
      base = null;
      info = null;
      retryAt = 0;
      streamAt = undefined;
      car.active = false;
      box.hidden = true;
      box.style.backgroundImage = "";
    },
    get duration() {
      return info && info.duration ? info.duration / 1000 : NaN;
    },
    // 0..1, for the movie to dip while someone in the party talks.
    level: 1,
    duck(level) {
      car.level = level;
      if (player) player.volume = level;
    },
    get currentTime() {
      return player && frames ? joinPos + player.currentTime : NaN;
    },
    // Twice a second from party.js: follow the party's clock. at: when the party last
    // played, paused or seeked, which is when its shared stream starts over.
    sync(playing, want, at) {
      if (!base || !ready) return;
      const now = Date.now();
      if (!playing) return stop(true);
      if (at !== streamAt) {
        // A new stretch: every car moves to its shared stream straight away (not after
        // falling out of step, which would also have looked like drift; see below).
        streamAt = at;
        rejoinedAt = 0;
        sharedQ = null; // a new stretch: this car's own quality again
        if (player) {
          stop(true);
          return open(false);
        }
      }
      if (!player) {
        if (now >= retryAt && now - openedAt > 1000) open(false);
        return;
      }
      watchGaps(now);
      const stuck = frames ? now - lastFrame > 10_000 : now - openedAt > 20_000; // stalled, or never got going
      const adrift = frames && now - openedAt > 8000 && Math.abs(car.currentTime - want) > 5; // out of step (a car on patchy data keeps up to 3 s in hand)
      if (!stuck && !adrift) return;
      // First, rejoin the party's shared stream (an H.264 car starts at its last
      // keyframe, within a second of everyone). Only if that didn't do it, a catch-up
      // stream of its own, which costs FSP a whole extra encode.
      const solo = now - rejoinedAt < 30_000;
      rejoinedAt = solo ? 0 : now;
      stop(true);
      open(solo);
    },
    unlock() {
      const out = player && player.audioOut;
      if (!out) return;
      if (out.unlock) out.unlock(() => {});
      if (out.context && out.context.resume) out.context.resume().catch(() => {});
    },
  };
  return car;
})();
