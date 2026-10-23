// Frunk — the car player for Watch Party. The Tesla pauses any <video> while
// driving, so in the car a Plex party plays here instead: FSP turns the title
// into H.264 (on its iGPU) or MPEG-1 video with MP2 audio in one stream, which JSMpeg
// decodes onto a <canvas> and Web Audio, keeping the two in step itself. H.264 is
// decoded by h264.js (the car's hardware decoder if its browser has one, else
// WebAssembly); a car that can't keep up steps down to 480p, then to MPEG-1. Every car in a party
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

  // What this car plays, remembered on it: H.264 at 720p on newer cars (AMD), 480p on
  // older or unknown ones; lower after it fell behind (see stepDown).
  const keep = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  let codec = "mpeg1";
  let quality = 720;
  let backend = null;
  let steppedAt = 0;
  // A quiet note for the Car check page in FSP (the owner's): how this car plays,
  // after its first minute (once per car) and when it steps down.
  let noteStart = 0; // this stream's first picture
  let noted = false;
  function carNote(why) {
    if (!base || !info) return;
    if (why === "first minute" && keep.get("frunk-carnote")) return;
    const secs = noteStart ? (Date.now() - noteStart) / 1000 : 0;
    const ctx = player && player.audioOut && player.audioOut.context;
    const note = {
      why, ua: navigator.userAgent, gpu: window.H264 ? window.H264.gpuName() : null, tier: window.H264 ? window.H264.carTier() : null,
      cores: navigator.hardwareConcurrency || null, decoder: codec === "h264" ? backend : "mpeg1", codec, quality,
      sourceFps: info.fps || null, fps: secs ? +(frames / secs).toFixed(1) : 0, seconds: Math.round(secs),
      sound: ctx ? ctx.state : "none",
    };
    f.api(`${base}/note`, { method: "POST", body: JSON.stringify(note), keepalive: true }).catch(() => {});
    if (why === "first minute") keep.set("frunk-carnote", "1");
  }
  function stepDown() {
    if (Date.now() - steppedAt < 15_000) return;
    steppedAt = Date.now();
    carNote("stepped down");
    if (codec === "h264" && quality > 480) {
      quality = 480;
      keep.set("frunk-car-q", "480");
      f.toast("The car is falling behind at 720p, so switching to 480p", 4000);
    } else if (codec === "h264") {
      codec = "mpeg1";
      keep.set("frunk-car-codec", "mpeg1");
      f.toast("Switching to the lighter video format for this car", 4000);
    } else return;
    stop(true);
    open(false); // the party's shared stream for the new setting
  }

  // A JSMpeg source over plain HTTP streaming, instead of its WebSocket one.
  function fetchSource(onHeaders, onFail) {
    return class FetchSource {
      constructor(url) {
        this.url = url;
        this.destination = null;
        this.streaming = true;
        this.established = false;
        this.completed = false;
        this.progress = 0;
        this.ctl = new AbortController();
      }
      connect(destination) {
        this.destination = destination;
      }
      start() {
        fetch(this.url, { signal: this.ctl.signal, credentials: "same-origin", cache: "no-store" })
          .then(async (r) => {
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "The car player couldn't start.");
            onHeaders(r.headers);
            this.progress = 1;
            const reader = r.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              this.established = true;
              if (this.destination) this.destination.write(value);
            }
            this.completed = true;
          })
          .catch((err) => {
            if (err.name !== "AbortError") onFail(err);
          });
      }
      resume() {}
      destroy() {
        this.ctl.abort();
      }
    };
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
  let rejoinedAt = 0; // when this car last rejoined the shared stream to catch up
  let ready = false; // load() has picked the codec and quality; no stream before that

  function stop(keepPicture) {
    if (player) {
      // A destroyed player blanks its canvas, so keep the last picture as a still.
      if (keepPicture && canvas && frames) {
        try { box.style.backgroundImage = `url(${canvas.toDataURL("image/jpeg", 0.85)})`; } catch {}
      }
      try { player.destroy(); } catch {}
      player = null;
    }
    if (canvas) canvas.remove();
    canvas = null;
    frames = 0;
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
    const me = canvas;
    const url = `${base}/stream?codec=${codec}&q=${quality}${solo ? `&solo=${Math.random().toString(36).slice(2, 10)}` : ""}`;
    const Source = fetchSource(
      (headers) => { joinPos = parseFloat(headers.get("x-stream-pos")) || 0; },
      (err) => {
        if (canvas !== me) return;
        stop(true);
        retryAt = Date.now() + 10_000;
        f.toast(err.message, 5000);
      },
    );
    const options = {
      source: Source, canvas, audio: true, video: true,
      pauseWhenHidden: false, preserveDrawingBuffer: true,
      videoBufferSize: 4 * 1024 * 1024, audioBufferSize: 512 * 1024,
      fps: (info && info.fps) || 30, backend,
      onBehind: () => { if (canvas === me) stepDown(); },
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
    player = codec === "h264" ? window.H264.createPlayer(url, options) : new window.JSMpeg.Player(url, options);
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
      // H.264 when FSP can encode it and this browser can decode it.
      codec = "mpeg1";
      try {
        await loadJsmpeg();
        const sup = await window.H264.support();
        backend = sup.webcodecs ? "webcodecs" : sup.wasm ? "wasm" : null;
        if (backend && info && (info.codecs || []).includes("h264")) codec = keep.get("frunk-car-codec") || "h264";
        quality = Number(keep.get("frunk-car-q")) || (window.H264.carTier() === "new" ? 720 : 480);
      } catch {}
      if (base === mine) ready = true;
    },
    unload() {
      ready = false;
      stop(false);
      base = null;
      info = null;
      retryAt = 0;
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
    // Twice a second from party.js: follow the party's clock.
    sync(playing, want) {
      if (!base || !ready) return;
      const now = Date.now();
      if (!playing) return stop(true);
      if (!player) {
        if (now >= retryAt && now - openedAt > 1000) open(false);
        return;
      }
      const stuck = frames ? now - lastFrame > 10_000 : now - openedAt > 20_000; // stalled, or never got going
      const adrift = frames && now - openedAt > 8000 && Math.abs(car.currentTime - want) > 3; // out of step
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
